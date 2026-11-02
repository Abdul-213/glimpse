import { describe, expect, test } from "bun:test";
import {
	type CaptureSource,
	type InstallState,
	languageCode,
	type PipelineEvent,
	type PipelineListener,
	type RecognisedBlock,
	rect,
	snipPopupFrame,
	TranslationPipeline,
} from "@glimpse/core";
import { FakeTranslationProvider, manualGate } from "@glimpse/core/testing";
import { createFileCaptureSource } from "../src/bun/services/capture/file.ts";
import { SAMPLE_FRAMES_DIR } from "../src/bun/services/capture/index.ts";
import {
	BLUR_GRACE_MS,
	COPIED_MS,
	INITIAL_CONTENT_HEIGHT,
	PAINT_TIMEOUT_MS,
	type PackPort,
	SCREEN_RECORDING_HELP_URL,
	SCREEN_RECORDING_SETTINGS_URL,
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
		expect(r.statuses.at(-1)).toBe("copied");
		// The final clipboard text: translated + neutral blocks, the skipped Korean one left out.
		expect(r.harness.clipboard).toEqual(["設定を保存しました。 [ja>en]\n100"]);
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

describe("loading and error states (GLIM-73)", () => {
	test("E1 no text: Snip again closes without restoring focus and reopens the picker", async () => {
		const { runner } = await realPipeline([]);
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		await settle();
		expect(h.window.last?.state.error).toBe("noText");
		h.controller.action("snip-1", "snipAgain");
		expect(h.controller.isOpen).toBe(false);
		expect(h.focusRestores()).toBe(0);
		expect(h.targets).toEqual(["snipAgain"]);
	});

	test("error actions lead to Settings and the macOS Screen Recording pane", async () => {
		const { runner } = await realPipeline(["a"]);
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		h.controller.action("snip-1", "checkKey");
		h.controller.action("snip-1", "editSources");
		h.controller.action("snip-1", "openSystemSettings");
		h.controller.action("snip-1", "why");
		h.controller.action("snip-1", "ocrSettings");
		expect(h.targets).toEqual([
			"settings:providers",
			"settings:languages",
			`url:${SCREEN_RECORDING_SETTINGS_URL}`,
			`url:${SCREEN_RECORDING_HELP_URL}`,
			"settings:providers",
		]);
		h.controller.action("snip-1", "close");
		expect(h.focusRestores()).toBe(1);
	});

	test("Copy original writes every non-skipped block's text with the OS line ends", async () => {
		const { runner } = await realPipeline(["明日の会議", "100"]);
		const h = popupHarness({ displays, runner, eol: "\r\n" });
		h.controller.open(rect(20, 15, 160, 40));
		await settle();
		h.controller.action("snip-1", "copyOriginal");
		expect(h.clipboard.at(-1)).toBe("明日の会議\r\n100");
		expect(h.controller.state?.copied).toBe("original");
		h.controller.dispose();
	});

	test("Retry on a failed block re-translates it, bypassing the cache", async () => {
		let failures = 1;
		const source = createFileCaptureSource(SAMPLE_FRAMES_DIR);
		const ocr = scriptedOcr(["明日の会議は午後三時に始まります。"]);
		await ocr.init();
		const tr = new FakeTranslationProvider({
			pivot: "en",
			capabilities: { streaming: false },
			fail: () => (failures-- > 0 ? "timeout" : null),
		});
		await tr.init();
		const pipeline = new TranslationPipeline({ ocr: () => ocr, chain: () => [tr] });
		const h = popupHarness({ displays, runner: pipelineRunner(source, pipeline, { to: L("en") }) });
		h.controller.open(rect(20, 15, 160, 40));
		await settle();
		expect(h.controller.state?.blocks[0]?.state).toBe("failed");
		expect(h.controller.state?.error).toBe("providerTimeout");
		h.controller.retryBlock("snip-1", "b1");
		await settle();
		expect(h.controller.state?.blocks[0]?.state).toBe("done");
		expect(h.controller.state?.phase).toBe("done");
		expect(h.controller.state?.error).toBeNull();
		h.controller.dispose();
	});

	test("E3 Translate on this device (GLIM-80): a one-off local translation, the pill goes back to On device", async () => {
		const source = createFileCaptureSource(SAMPLE_FRAMES_DIR);
		const ocr = scriptedOcr(["明日の会議は午後三時に始まります。"]);
		await ocr.init();
		const cloud = new FakeTranslationProvider({
			id: "cloud:fake",
			name: "Fake Cloud Translate",
			kind: "cloud",
			vendor: "Fake",
			pivot: "en",
			capabilities: { streaming: false },
			fail: () => "timeout",
		});
		const local = new FakeTranslationProvider({ pivot: "en", capabilities: { streaming: false } });
		await cloud.init();
		await local.init();
		const pipeline = new TranslationPipeline({ ocr: () => ocr, chain: () => [cloud, local] });
		let localReady = true;
		const runner: SnipRunner = {
			...pipelineRunner(source, pipeline, { to: L("en") }),
			canTranslateLocally: () => localReady,
		};
		const h = popupHarness({ displays, runner, providerShortName: (id) => (id === "cloud:fake" ? "Fake" : null) });
		h.controller.open(rect(20, 15, 160, 40));
		await settle();
		expect(h.controller.state?.error).toBe("providerTimeout");
		expect(h.window.last?.localAvailable).toBe(true);
		expect(h.window.last?.providerShortName).toBe("Fake");
		localReady = false;
		h.controller.toggleSkipped("snip-1", false); // any push re-reads it
		await settle();
		expect(h.window.last?.localAvailable).toBe(false);

		h.controller.action("snip-1", "local");
		await settle();
		expect(h.controller.state?.error).toBeNull();
		expect(h.controller.state?.blocks[0]?.state).toBe("done");
		expect(h.controller.state?.provider).toEqual({ kind: "local" });
		expect(h.window.last?.providerShortName).toBeNull();
		expect(h.clipboard).toHaveLength(1);
		h.controller.dispose();
	});

	test("Translate these translates the skipped blocks in place", async () => {
		const source = createFileCaptureSource(SAMPLE_FRAMES_DIR);
		const ocr = scriptedOcr(["明日の会議", "안녕하세요"]);
		await ocr.init();
		const tr = new FakeTranslationProvider({ pivot: "en", capabilities: { streaming: false } });
		await tr.init();
		const pipeline = new TranslationPipeline({ ocr: () => ocr, chain: () => [tr] });
		const h = popupHarness({
			displays,
			runner: pipelineRunner(source, pipeline, { to: L("en"), sources: [L("ja")] }),
		});
		h.controller.open(rect(20, 15, 160, 40));
		await settle();
		expect(h.controller.state?.blocks[1]?.cls).toBe("skip");
		h.controller.action("snip-1", "translateSkipped");
		await settle();
		expect(h.controller.state?.blocks[1]).toMatchObject({ cls: "translate", promoted: true, state: "done" });
		expect(h.controller.state?.phase).toBe("done");
		h.controller.dispose();
	});

	test("Download: consent goes to the pack port; when the pack lands its blocks translate in place", async () => {
		const states = new Map<string, InstallState>();
		let notify: (id: string, s: InstallState) => void = () => {};
		const downloads: string[][] = [];
		const packs: PackPort = {
			download: async (ids) => {
				downloads.push([...ids]);
			},
			state: (id) => states.get(id) ?? { status: "missing" },
			subscribe: (l) => {
				notify = l;
				return () => {};
			},
		};
		const waiting: RecognisedBlock = {
			id: "g1",
			order: 0,
			box: rect(0, 0, 100, 20),
			text: "Προσφορά",
			confidence: 1,
			language: { kind: "language", lang: L("el"), confidence: 1 },
			lang: L("el"),
			cls: "translate",
			direction: "ltr",
			waitingForPack: true,
		};
		const translated: string[] = [];
		const runner: SnipRunner = {
			snip: async (_r, onEvent, _s, runId) => {
				onEvent({ type: "recognised", runId, blocks: [waiting] });
				onEvent({
					type: "packs",
					runId,
					rows: [
						{
							lang: L("el"),
							state: "missing",
							resourceIds: ["bergamot-elen"],
							bytes: 31_000_000,
							progress: null,
							segmentIds: ["g1"],
						},
					],
				});
			},
			translate: async (blocks, onEvent, _s, runId) => {
				for (const b of blocks) {
					translated.push(b.id);
					onEvent({
						type: "translation",
						runId,
						translation: {
							blockId: b.id,
							text: "Offer",
							final: true,
							failure: null,
							from: L("el"),
							to: L("en"),
							via: [],
							provider: null,
						},
					});
				}
			},
		};
		const h = popupHarness({ displays, runner, packs });
		h.controller.open(rect(20, 15, 160, 40));
		await settle();
		expect(h.controller.state?.packs[0]?.state).toBe("missing");
		h.controller.action("snip-1", "download", "el");
		expect(downloads).toEqual([["bergamot-elen"]]);
		states.set("bergamot-elen", { status: "downloading", receivedBytes: 10, totalBytes: 100 });
		notify("bergamot-elen", { status: "downloading", receivedBytes: 10, totalBytes: 100 });
		expect(h.controller.state?.packs[0]).toMatchObject({ state: "downloading", received: 10, total: 100 });
		states.set("bergamot-elen", { status: "installed", version: "1", bundled: false });
		notify("bergamot-elen", { status: "installed", version: "1", bundled: false });
		await settle();
		expect(translated).toEqual(["g1"]);
		expect(h.controller.state?.packs).toEqual([]);
		expect(h.controller.state?.blocks[0]).toMatchObject({ state: "done", translation: "Offer" });
		h.controller.dispose();
	});
});

describe("show original (GLIM-74)", () => {
	test("the toggle round-trips through main; a new Snip starts in the translation view", async () => {
		const { runner } = await realPipeline(["明日の会議"]);
		const h = popupHarness({ displays, runner, settings: { showOriginalUnder: true } });
		h.controller.open(rect(20, 15, 160, 40));
		await settle();
		expect(h.window.last?.state.showOriginalUnder).toBe(true);
		h.controller.toggleOriginal("snip-1", true);
		await settle();
		expect(h.window.last?.state.view).toBe("original");
		h.controller.toggleOriginal("snip-0", false);
		await settle();
		expect(h.window.last?.state.view).toBe("original");
		h.controller.open(rect(20, 15, 160, 40));
		expect(h.window.last?.state.view).toBe("translation");
		h.controller.dispose();
	});
});

describe("auto-copy (GLIM-71)", () => {
	test("the translation is copied once when the run is done; 'Copied' shows for 2 s", async () => {
		const { runner } = await realPipeline(["明日の会議", "100"]);
		const h = popupHarness({ displays, runner, eol: "\r\n" });
		h.controller.open(rect(20, 15, 160, 40));
		await settle();
		expect(h.clipboard).toEqual(["明日の会議 [ja>en]\r\n100"]);
		expect(h.controller.state?.copied).toBe("translation");
		h.controller.toggleOriginal("snip-1", true);
		h.controller.toggleOriginal("snip-1", false);
		expect(h.clipboard.length).toBe(1);
		h.scheduler.advance(COPIED_MS);
		expect(h.controller.state?.copied).toBeNull();
		h.controller.dispose();
	});

	test("nothing is written while streaming, with the setting off, or on an error", async () => {
		const gate = manualGate();
		const { runner } = await realPipeline(["明日の会議"], gate);
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		await settle();
		expect(h.clipboard).toEqual([]);
		gate.open();
		await settle();
		expect(h.clipboard.length).toBe(1);
		h.controller.dispose();

		const off = popupHarness({
			displays,
			runner: (await realPipeline(["明日の会議"])).runner,
			settings: { autoCopy: false },
		});
		off.controller.open(rect(20, 15, 160, 40));
		await settle();
		expect(off.clipboard).toEqual([]);
		expect(off.controller.state?.phase).toBe("done");
		off.controller.dispose();

		const e1 = popupHarness({ displays, runner: (await realPipeline([])).runner });
		e1.controller.open(rect(20, 15, 160, 40));
		await settle();
		expect(e1.controller.state?.error).toBe("noText");
		e1.controller.copy("snip-1", "translation");
		expect(e1.clipboard).toEqual([]);
	});

	test("Ctrl/⌘C copies again, Ctrl/⌘⇧C copies the original", async () => {
		const { runner } = await realPipeline(["明日の会議", "100"]);
		const h = popupHarness({ displays, runner });
		h.controller.open(rect(20, 15, 160, 40));
		await settle();
		h.controller.copy("snip-1", "translation");
		h.controller.copy("snip-1", "original");
		expect(h.clipboard).toEqual(["明日の会議 [ja>en]\n100", "明日の会議 [ja>en]\n100", "明日の会議\n100"]);
		expect(h.controller.state?.copied).toBe("original");
		h.controller.dispose();
	});

	test("'Translate these' rewrites the clipboard once with the skipped blocks included", async () => {
		const source = createFileCaptureSource(SAMPLE_FRAMES_DIR);
		const ocr = scriptedOcr(["明日の会議", "안녕하세요"]);
		await ocr.init();
		const tr = new FakeTranslationProvider({ pivot: "en", capabilities: { streaming: false } });
		await tr.init();
		const pipeline = new TranslationPipeline({ ocr: () => ocr, chain: () => [tr] });
		const h = popupHarness({
			displays,
			runner: pipelineRunner(source, pipeline, { to: L("en"), sources: [L("ja")] }),
		});
		h.controller.open(rect(20, 15, 160, 40));
		await settle();
		expect(h.clipboard).toEqual(["明日の会議 [ja>en]"]);
		h.controller.action("snip-1", "translateSkipped");
		await settle();
		expect(h.clipboard).toEqual(["明日の会議 [ja>en]", "明日の会議 [ja>en]\n안녕하세요 [ko>en]"]);
		h.controller.dispose();
	});
});
