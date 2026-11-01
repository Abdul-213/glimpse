import { describe, expect, test } from "bun:test";
import {
	type CaptureSource,
	languageCode,
	type PipelineEvent,
	type PipelineListener,
	rect,
	snipPopupFrame,
	TranslationPipeline,
} from "@glimpse/core";
import { FakeTranslationProvider, manualGate } from "@glimpse/core/testing";
import { createFileCaptureSource } from "../src/bun/services/capture/file.ts";
import { SAMPLE_FRAMES_DIR } from "../src/bun/services/capture/index.ts";
import {
	BLUR_GRACE_MS,
	INITIAL_CONTENT_HEIGHT,
	PAINT_TIMEOUT_MS,
	type SnipRunner,
} from "../src/bun/windows/popup-controller.ts";
import { macFlipOffset, snipViewInit } from "../src/bun/windows/popup-init.ts";
import { pipelineRunner, popupHarness, popupLines, runSnipPopup } from "../src/harness/popup.ts";
import { scriptedOcr } from "../src/harness/providers.ts";

const L = languageCode;
const settle = () => Bun.sleep(5);
// Placement runs against a full-size display; capture reads the small sample recording.
const DESK = [
	{
		id: 1,
		bounds: rect(0, 0, 1440, 900),
		workArea: rect(0, 0, 1440, 852),
		scaleFactor: 2,
		isPrimary: true,
	},
];
const displays = () => DESK;

async function realPipeline(lines: string[], gate?: ReturnType<typeof manualGate>) {
	const source: CaptureSource = createFileCaptureSource(SAMPLE_FRAMES_DIR);
	const ocr = scriptedOcr(lines);
	await ocr.init();
	const tr = new FakeTranslationProvider({
		pivot: "en",
		capabilities: { streaming: false },
		...(gate ? { gate: gate.wait } : {}),
	});
	await tr.init();
	const pipeline = new TranslationPipeline({ ocr: () => ocr, chain: () => [tr] });
	return { source, runner: pipelineRunner(source, pipeline, { to: L("en") }) };
}

describe("SnipPopupController (GLIM-65)", () => {
	test("open: placed next to the region, moved while hidden, S0 pushed, shown when the view paints", async () => {
		const { runner } = await realPipeline(["明日の会議は午後三時に始まります。"]);
		const h = popupHarness({ displays, runner });
		const region = rect(20, 15, 160, 40);
		const id = h.controller.open(region);
		expect(id).toBe("snip-1");
		const placement = h.controller.placement;
		expect(placement?.side).toBe("below");
		// The frame is set before anything is shown (DPI: re-rasterise while hidden).
		expect(h.window.frames[0]).toEqual(
			snipPopupFrame(placement as NonNullable<typeof placement>, INITIAL_CONTENT_HEIGHT),
		);
		expect(h.window.visible).toBe(false);
		expect(h.window.messages[0]?.state.phase).toBe("opened");
		expect(h.window.messages[0]?.layout.side).toBe("below");
		h.controller.painted("snip-1");
		expect(h.window.visible).toBe(true);
		h.controller.painted("snip-1");
		expect(h.window.shows).toBe(1);
		h.controller.dispose();
	});

	test("shows anyway after 32 ms if the view never reports painted", async () => {
		const { runner } = await realPipeline(["こんにちは"]);
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		h.scheduler.advance(PAINT_TIMEOUT_MS - 1);
		expect(h.window.visible).toBe(false);
		h.scheduler.advance(1);
		expect(h.window.visible).toBe(true);
		h.controller.dispose();
	});

	test("streams the pipeline into the view: boxes, source text, then translations", async () => {
		const gate = manualGate();
		const { runner } = await realPipeline(["明日の会議は午後三時に始まります。", "100"], gate);
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		await settle();
		const pending = h.window.last?.state;
		expect(pending?.blocks.map((b) => [b.cls, b.state])).toEqual([
			["translate", "pending"],
			["neutral", "done"],
		]);
		gate.open();
		await settle();
		const done = h.window.last?.state;
		expect(done?.phase).toBe("done");
		expect(done?.blocks[0]?.translation).toBe("明日の会議は午後三時に始まります。 [ja>en]");
		// Coalesced: far fewer pushes than pipeline events.
		expect(h.window.messages.length).toBeLessThan(10);
		h.controller.dispose();
	});

	test("resize: the view's content height becomes the frame, anchored, capped at maxHeight", async () => {
		const { runner } = await realPipeline(["a"]);
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		const p = h.controller.placement;
		if (!p) throw new Error("no placement");
		h.controller.resized("snip-1", 180);
		expect(h.window.frame).toEqual(snipPopupFrame(p, 180));
		const n = h.window.frames.length;
		h.controller.resized("snip-1", 180);
		expect(h.window.frames.length).toBe(n);
		h.controller.resized("snip-1", 100_000);
		expect(h.window.frame?.height).toBeLessThanOrEqual(p.maxHeight);
		// A stale request's resize is ignored.
		h.controller.resized("snip-0", 50);
		expect(h.window.frames.length).toBe(n + 1);
		h.controller.dispose();
	});

	test("Esc and Close hide the popup, take the results layer down and give focus back", async () => {
		const { runner } = await realPipeline(["a"]);
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		h.controller.painted("snip-1");
		h.controller.dismiss("snip-1", "esc");
		expect(h.window.visible).toBe(false);
		expect(h.controller.isOpen).toBe(false);
		expect(h.resultsDismissed()).toBe(1);
		expect(h.focusRestores()).toBe(1);
		h.controller.open(rect(20, 15, 160, 40));
		h.controller.dismiss("snip-2", "close");
		expect(h.focusRestores()).toBe(2);
	});

	test("a second Snip replaces the first: its run is cancelled and its late events are dropped", async () => {
		let first: PipelineListener | null = null;
		let firstSignal: AbortSignal | null = null;
		const runner: SnipRunner = {
			snip: (_r, onEvent, signal, runId) => {
				if (runId === "snip-1") {
					first = onEvent;
					firstSignal = signal;
				}
				return new Promise(() => {});
			},
		};
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		h.controller.open(rect(20, 15, 160, 40));
		expect((firstSignal as AbortSignal | null)?.aborted).toBe(true);
		expect(h.focusRestores()).toBe(0);
		const late: PipelineEvent = { type: "recognised", runId: "snip-1", blocks: [] };
		(first as PipelineListener | null)?.(late);
		await settle();
		expect(h.controller.state?.requestId).toBe("snip-2");
		expect(h.controller.state?.phase).toBe("opened");
		h.controller.dispose();
	});

	test("skipped line toggles through main (main owns the state)", async () => {
		const { runner } = await realPipeline(["a"]);
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		h.controller.toggleSkipped("snip-1", true);
		await settle();
		expect(h.window.last?.state.skippedExpanded).toBe(true);
		h.controller.dispose();
	});
});

describe("harness: scripted Snip → pipeline → popup state (GLIM-86 + GLIM-65)", () => {
	test("runSnipPopup over the sample recording", async () => {
		const source = createFileCaptureSource(SAMPLE_FRAMES_DIR);
		const ocr = scriptedOcr(["設定を保存しました。", "100", "안녕하세요"]);
		await ocr.init();
		const tr = new FakeTranslationProvider({ pivot: "en", capabilities: { streaming: false } });
		await tr.init();
		const r = await runSnipPopup(source, rect(20, 15, 160, 90), {
			pipeline: new TranslationPipeline({ ocr: () => ocr, chain: () => [tr] }),
			to: L("en"),
			sources: [L("ja")],
			displays,
		});
		expect(r.shown).toBe(true);
		expect(r.placement?.side).toBe("below");
		expect(r.statuses[0]).toBe("reading");
		expect(r.statuses.at(-1)).toBe("none");
		expect(r.state?.phase).toBe("done");
		expect(r.state?.blocks.map((b) => [b.cls, b.state])).toEqual([
			["translate", "done"],
			["neutral", "done"],
			["skip", "done"],
		]);
		expect(popupLines(r)[0]).toContain("below on display 1");
	});
});

describe("placement and dismissal (GLIM-72)", () => {
	test("click outside dismisses and restores focus", async () => {
		const { runner } = await realPipeline(["a"]);
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		h.controller.painted("snip-1");
		h.controller.outsideClick();
		expect(h.window.visible).toBe(false);
		expect(h.focusRestores()).toBe(1);
		expect(h.resultsDismissed()).toBe(1);
	});

	test("losing key to another app dismisses after the grace period, without restoring focus", async () => {
		const { runner } = await realPipeline(["a"]);
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		h.controller.painted("snip-1");
		h.controller.windowFocus(false);
		h.scheduler.advance(BLUR_GRACE_MS - 1);
		expect(h.controller.isOpen).toBe(true);
		h.scheduler.advance(1);
		expect(h.controller.isOpen).toBe(false);
		expect(h.focusRestores()).toBe(0);
	});

	test("blur then a click on the results layer counts as outside (focus restored once)", async () => {
		const { runner } = await realPipeline(["a"]);
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		h.controller.painted("snip-1");
		h.controller.windowFocus(false);
		h.controller.outsideClick();
		h.scheduler.advance(BLUR_GRACE_MS * 2);
		expect(h.focusRestores()).toBe(1);
	});

	test("focus coming back cancels the pending blur; blur before the window is shown is ignored", async () => {
		const { runner } = await realPipeline(["a"]);
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		h.controller.windowFocus(false);
		h.scheduler.advance(BLUR_GRACE_MS * 2);
		expect(h.controller.isOpen).toBe(true);
		h.controller.painted("snip-1");
		h.controller.windowFocus(false);
		h.controller.windowFocus(true);
		h.scheduler.advance(BLUR_GRACE_MS * 2);
		expect(h.controller.isOpen).toBe(true);
		h.controller.dispose();
	});

	test("a new hotkey dismisses without restoring focus", async () => {
		const { runner } = await realPipeline(["a"]);
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		h.controller.dismiss(null, "hotkey");
		expect(h.controller.isOpen).toBe(false);
		expect(h.focusRestores()).toBe(0);
	});

	test("a dragged popup stays where it was dropped and grows from there", async () => {
		const { runner } = await realPipeline(["a"]);
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		const before = h.controller.frame;
		// Our own setFrame echoes back as a move: ignored.
		h.controller.moved(before?.x ?? 0, before?.y ?? 0);
		expect(h.controller.placement?.x).toBe(before?.x ?? -1);
		h.controller.moved(600, 400);
		h.controller.resized("snip-1", 200);
		expect(h.window.frame).toMatchObject({ x: 600, y: 400, height: 200 });
		h.controller.dispose();
	});

	test("multi-monitor: the popup goes on the display that holds the region, inside its work area", async () => {
		const two = [
			...DESK,
			{
				id: 2,
				bounds: rect(1440, 0, 1280, 800),
				workArea: rect(1440, 25, 1280, 775),
				scaleFactor: 1,
				isPrimary: false,
			},
		];
		const { runner } = await realPipeline(["a"]);
		const h = popupHarness({ displays: () => two, runner });
		h.controller.open(rect(2500, 300, 200, 60));
		const p = h.controller.placement;
		expect(p?.displayId).toBe(2);
		const f = h.window.frame;
		expect((f?.x ?? 0) + (f?.width ?? 0)).toBeLessThanOrEqual(1440 + 1280 - 8);
		h.controller.dispose();
	});
});

describe("popup window helpers", () => {
	test("macOS Y-flip offset: zero on equal heights, the height difference otherwise", () => {
		expect(macFlipOffset(900, 900)).toBe(0);
		expect(macFlipOffset(1440, 900)).toBe(540);
		expect(macFlipOffset(800, 1117)).toBe(-317);
	});

	test("view init: OS-specific shortcut labels", () => {
		expect(snipViewInit("macos").keys).toEqual({ copy: "⌘C", copyOriginal: "⌘⇧C", original: "⌘⇧O", close: "Esc" });
		expect(snipViewInit("windows").keys.original).toBe("Ctrl+Shift+O");
	});
});
