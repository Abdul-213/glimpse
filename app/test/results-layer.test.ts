// GLIM-115: detection boxes on the results layer under the Snip popup (snip-popup.md §2.3).
import { describe, expect, test } from "bun:test";
import {
	type BlockClass,
	boxToGlobal,
	type Display,
	languageCode,
	NO_MODIFIERS,
	nullLogger,
	type PipelineEvent,
	type RecognisedBlock,
	type ResultsLayerState,
	rect,
	resultsBoxes,
} from "@glimpse/core";
import { FakePointer, RecordingFocusKeeper, SolidPixelSampler, StaticWindowList } from "@glimpse/core/testing";
import { PickerController } from "../src/bun/windows/picker-controller.ts";
import type { SnipRunner } from "../src/bun/windows/popup-controller.ts";
import { FakeOverlayFactory, ManualScheduler } from "../src/harness/overlays.ts";
import { popupHarness } from "../src/harness/popup.ts";

const L = languageCode;
const DESK: Display[] = [
	{ id: 1, bounds: rect(0, 0, 1440, 900), workArea: rect(0, 0, 1440, 852), scaleFactor: 2, isPrimary: true },
];
const REGION = rect(100, 200, 160, 40);
const RUN = "snip-1";

const rb = (
	id: string,
	order: number,
	box: ReturnType<typeof rect>,
	cls: BlockClass,
	lang: string | null,
): RecognisedBlock => ({
	id,
	order,
	box,
	text: id,
	confidence: 0.9,
	language: lang ? { kind: "language", lang: L(lang), confidence: 1 } : { kind: "skipped", lang: null, confidence: 0 },
	lang: lang ? L(lang) : null,
	cls,
	direction: "ltr",
	waitingForPack: false,
});

describe("resultsBoxes (core)", () => {
	test("region-local device px to global logical", () => {
		expect(boxToGlobal(REGION, 2, rect(20, 10, 100, 40))).toEqual(rect(110, 205, 50, 20));
	});

	test("translate/target solid, skipped dashed, neutral none, clipped to the region", () => {
		const boxes = resultsBoxes(REGION, 2, [
			{ id: "a", box: rect(0, 0, 100, 20), cls: "translate" },
			{ id: "b", box: rect(0, 20, 40, 20), cls: "neutral" },
			{ id: "c", box: rect(0, 40, 100, 20), cls: "skip" },
			{ id: "d", box: rect(200, 60, 200, 20), cls: "target" },
			{ id: "e", box: rect(0, 0, 10, 10), cls: null },
		]);
		expect(boxes.map((b) => [b.id, b.style])).toEqual([
			["a", "solid"],
			["c", "dashed"],
			["d", "solid"],
			["e", "solid"],
		]);
		expect(boxes[2]?.rect).toEqual(rect(200, 230, 60, 10)); // clipped at the region's right edge
	});
});

/** A runner that plays scripted pipeline events, holding before `done` until released. */
function scriptedRunner() {
	let release: () => void = () => {};
	const runner: SnipRunner = {
		snip: async (_rect, onEvent, _signal, runId) => {
			const ev = (e: PipelineEvent) => onEvent(e);
			ev({
				type: "started",
				runId,
				mode: "snip",
				target: L("en"),
				private: false,
				ocr: { id: "paddleocr", kind: "local", name: "PaddleOCR" },
				translation: { id: "bergamot", kind: "local", name: "On-device translation" },
			});
			ev({
				type: "detected",
				runId,
				image: { width: 320, height: 80 },
				boxes: [
					{ id: "d1", box: rect(0, 0, 200, 20) },
					{ id: "d2", box: rect(0, 40, 100, 20) },
				],
			});
			await Bun.sleep(1);
			ev({
				type: "recognised",
				runId,
				blocks: [
					rb("b1", 0, rect(0, 0, 200, 20), "translate", "es"),
					rb("b2", 1, rect(0, 30, 40, 20), "neutral", null),
					rb("b3", 2, rect(0, 50, 120, 20), "skip", "ru"),
				],
			});
			await new Promise<void>((r) => {
				release = r;
			});
			return undefined;
		},
	};
	return { runner, release: () => release() };
}

describe("Snip popup → results layer (GLIM-115)", () => {
	test("boxes come with the skeleton bars, take their classes, follow hover, clear on close", async () => {
		const { runner } = scriptedRunner();
		const h = popupHarness({ displays: () => DESK, runner });
		h.controller.open(REGION);
		// Detection arrives in the same push as the skeleton bars.
		await Bun.sleep(0);
		const detected = h.boxes.at(-1) as ResultsLayerState;
		expect(h.window.last?.state.skeletons).toHaveLength(2);
		expect(detected.boxes.map((b) => [b.id, b.style])).toEqual([
			["d1", "solid"],
			["d2", "solid"],
		]);
		expect(detected.boxes[0]?.rect).toEqual(rect(100, 200, 100, 10));

		await Bun.sleep(5);
		const recognised = h.boxes.at(-1) as ResultsLayerState;
		expect(recognised.boxes.map((b) => [b.id, b.style])).toEqual([
			["b1", "solid"],
			["b3", "dashed"],
		]);
		expect(recognised.linkedId).toBeNull();

		const pushes = h.boxes.length;
		h.controller.hoverBlock(RUN, "b1");
		expect(h.boxes.at(-1)?.linkedId).toBe("b1");
		h.controller.hoverBlock(RUN, "b1");
		expect(h.boxes.length).toBe(pushes + 1); // unchanged: not re-sent
		h.controller.hoverBlock(RUN, "nope");
		expect(h.boxes.at(-1)?.linkedId).toBeNull();
		h.controller.hoverBlock("other-request", "b1");
		expect(h.boxes.at(-1)?.linkedId).toBeNull();

		h.controller.dismiss(RUN, "esc");
		expect(h.boxes.at(-1)).toBeNull();
		expect(h.resultsDismissed()).toBe(1);
	});
});

describe("PickerController results layer (GLIM-115)", () => {
	function picker() {
		const factory = new FakeOverlayFactory();
		const scheduler = new ManualScheduler();
		const controller = new PickerController({
			factory,
			displays: () => DESK,
			probe: new FakePointer({ x: 300, y: 300 }),
			windows: new StaticWindowList([]),
			sampler: new SolidPixelSampler(),
			focus: new RecordingFocusKeeper(),
			os: "windows",
			log: nullLogger,
			now: scheduler.now,
			scheduler,
			settings: () => ({ confirmOnRelease: true, showLoupe: true, reducedMotion: true }),
		});
		controller.onRegionSelected(() => "keep");
		return { controller, factory };
	}
	const state: ResultsLayerState = {
		requestId: RUN,
		boxes: [{ id: "b1", rect: rect(10, 10, 50, 20), style: "solid" }],
		linkedId: null,
	};

	test("boxes reach every overlay only while the layer is up; a late view gets them; dismiss clears", async () => {
		const { controller, factory } = picker();
		controller.showResults(state); // no results layer yet
		controller.open("snip");
		const [o] = factory.created;
		expect(o?.resultsSent).toEqual([]);
		controller.viewKey({ displayId: 1, key: "ArrowRight", down: true, repeat: false, mods: NO_MODIFIERS });
		controller.viewKey({ displayId: 1, key: "Enter", down: true, repeat: false, mods: NO_MODIFIERS });
		controller.showResults(state);
		expect(o?.resultsSent).toEqual([state]);
		controller.viewInit(1);
		await Bun.sleep(0);
		expect(o?.resultsSent.at(-1)).toEqual(state);
		controller.dismiss();
		expect(o?.resultsSent.at(-1)).toBeNull();
	});

	test("a new open clears the old boxes", () => {
		const { controller, factory } = picker();
		controller.open("snip");
		controller.viewKey({ displayId: 1, key: "ArrowRight", down: true, repeat: false, mods: NO_MODIFIERS });
		controller.viewKey({ displayId: 1, key: "Enter", down: true, repeat: false, mods: NO_MODIFIERS });
		controller.showResults(state);
		controller.open("snip");
		expect(factory.created[0]?.resultsSent.at(-1)).toBeNull();
	});
});
