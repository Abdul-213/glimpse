// GLIM-67: skip re-translating unchanged blocks. A two-line region where only the second line
// changes: the first line's sentence is served by the session's translation cache (the
// translator never sees it again), the popup gets no upsert or translation event for it, and
// the runner reports the reuse (the app logs it at debug level). Change detection (GLIM-58)
// and the frame ring already stop OCR for unchanged frames; this covers the frames that do
// change.
import { expect, test } from "bun:test";
import {
	type LiveCacheInfo,
	LivePipelineSession,
	LiveRunner,
	type LiveSessionEvent,
	languageCode,
	type OcrImage,
	rect,
	TranslationCaches,
	TranslationPipeline,
} from "@glimpse/core";
import {
	FakeOcrProvider,
	FakeTranslationProvider,
	ManualTimers,
	makeImage,
	ocrBlock,
	ReplayCaptureSource,
} from "@glimpse/core/testing";

const W = 200;
const H = 80;
type Rgb = readonly [number, number, number];
const BG: Rgb = [20, 20, 20];
const RED: Rgb = [220, 40, 40];
const GREEN: Rgb = [40, 200, 40];
const BLUE: Rgb = [40, 40, 220];
const TEXT = new Map([
	["220,40,40", "扉は閉まっている。"],
	["40,200,40", "衛兵と話して。"],
	["40,40,220", "塔の鍵を探して。"],
]);

/** Two bars: line 1 at y 5..35, line 2 at y 45..75. */
const scene = (top: Rgb, bottom: Rgb) =>
	makeImage(W, H, (x, y) => (x < 10 || x >= 190 ? BG : y >= 5 && y < 35 ? top : y >= 45 && y < 75 ? bottom : BG));

function twoLineOcr() {
	return new FakeOcrProvider({
		blocks: (req) => {
			const img: OcrImage = req.image;
			const at = (y: number) => {
				const i = y * img.stride + 20 * 4;
				return TEXT.get(`${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`) ?? "";
			};
			return [ocrBlock("t", at(20), rect(10, 5, 180, 30)), ocrBlock("b", at(60), rect(10, 45, 180, 30))].filter(
				(b) => b.text !== "",
			);
		},
	});
}

test("only the changed line is translated again; the unchanged one comes from the cache", async () => {
	const timers = new ManualTimers(1_000_000);
	const ocr = twoLineOcr();
	await ocr.init();
	const translator = new FakeTranslationProvider({ capabilities: { streaming: false } });
	await translator.init();
	const pipeline = new TranslationPipeline({ ocr: () => ocr, chain: () => [translator], clock: timers });
	const session = new LivePipelineSession({
		pipeline,
		caches: new TranslationCaches({ now: timers.now }),
		target: languageCode("en"),
		sources: [],
		private: false,
	});
	const source = new ReplayCaptureSource(
		[
			{ image: scene(RED, GREEN), holdMs: 2000 },
			{ image: scene(RED, BLUE), holdMs: 2000 },
			{ image: scene(RED, GREEN), holdMs: 2000 },
		],
		{ advance: "timed", now: timers.now },
	);
	const events: LiveSessionEvent[] = [];
	const cache: LiveCacheInfo[] = [];
	const runner = new LiveRunner({
		sessionId: "s",
		region: rect(0, 0, W, H),
		source: await source.openSession(rect(0, 0, W, H), { fps: 3 }),
		timers,
		processor: session,
		fps: 3,
		diffThreshold: 0.02,
		stabilityMs: 300,
		onEvent: (e) => events.push(e),
		onCache: (c) => cache.push(c),
	});
	runner.start();
	await timers.advance(5000);
	runner.stop();

	const sent = translator.calls.flatMap((c) => c.segments.map((s) => s.text));
	// Frame 1: both lines. Frame 2: only the new second line; line 1 is a cache hit.
	expect(sent).toEqual(["扉は閉まっている。", "衛兵と話して。", "塔の鍵を探して。"]);
	expect(cache.map((c) => [c.translated, c.cached])).toEqual([
		[2, 0],
		[2, 1],
	]);
	const frames = events.filter((e) => e.type === "frame");
	const second = frames[1];
	expect(second?.type === "frame" && second.upserts.map((u) => u.source)).toEqual(["塔の鍵を探して。"]);
	// No translation event for the unchanged line after the first fill.
	const line1 = second?.type === "frame" ? second.order[0] : undefined;
	const late = events.filter((e) => e.type === "translation" && e.frameSeq >= 2);
	expect(late.some((e) => e.type === "translation" && e.id === line1)).toBe(false);
	// Frame 3 is frame 1 again: the frame ring reuses it, no OCR, no translator call.
	const stats = runner.stats();
	expect(stats.ringHits).toBe(1);
	expect(stats.ocrRuns).toBe(2);
	expect(stats.translatedBlocks).toBe(4);
	expect(stats.cachedBlocks).toBe(1);
});
