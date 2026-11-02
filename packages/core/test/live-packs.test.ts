// GLIM-123 (live-popup.md L12): a Live session whose blocks wait for a language pack emits a
// `packs` event with the session's stable block ids, keeps running, and once the pack is in
// and the region is re-read (`invalidate`), the rows clear and the blocks translate.
import { describe, expect, test } from "bun:test";
import {
	LivePipelineSession,
	LiveRunner,
	type LiveSessionEvent,
	languageCode,
	rect,
	TranslationCaches,
	TranslationPipeline,
	type TranslationProvider,
} from "@glimpse/core";
import {
	FakeOcrProvider,
	FakeTranslationProvider,
	ManualTimers,
	makeImage,
	ocrBlock,
	ReplayCaptureSource,
} from "@glimpse/core/testing";

async function setup() {
	const timers = new ManualTimers(1_000_000);
	const ocr = new FakeOcrProvider({ blocks: () => [ocrBlock("b1", "こんにちは", rect(10, 10, 180, 30))] });
	await ocr.init();
	const missing = new FakeTranslationProvider({ missing: [["ja", "en"]], capabilities: { streaming: false } });
	const ready = new FakeTranslationProvider({ capabilities: { streaming: false } });
	await missing.init();
	await ready.init();
	let chain: TranslationProvider[] = [missing];
	const pipeline = new TranslationPipeline({ ocr: () => ocr, chain: () => chain, clock: timers });
	const session = new LivePipelineSession({
		pipeline,
		caches: new TranslationCaches({ now: timers.now }),
		target: languageCode("en"),
		sources: [],
		private: false,
	});
	const image = makeImage(200, 50, (x, y) => (y > 10 && y < 40 && x > 10 && x < 190 ? [200, 40, 40] : [20, 20, 20]));
	const source = new ReplayCaptureSource([{ image, holdMs: 60_000, name: "static" }], {
		advance: "timed",
		now: timers.now,
		end: "hold",
	});
	const capture = await source.openSession(rect(0, 0, 200, 50), { fps: 3 });
	const events: LiveSessionEvent[] = [];
	const runner = new LiveRunner({
		sessionId: "s1",
		region: rect(0, 0, 200, 50),
		source: capture,
		timers,
		processor: session,
		fps: 3,
		diffThreshold: 0.02,
		stabilityMs: 300,
		onEvent: (e) => events.push(e),
	});
	const t0 = timers.now();
	return {
		runner,
		events,
		ocr,
		at: (ms: number) => timers.advanceTo(t0 + ms),
		install: () => {
			chain = [ready];
		},
	};
}

const packs = (events: LiveSessionEvent[]) => events.filter((e) => e.type === "packs");

describe("Live pack rows (GLIM-123)", () => {
	test("waiting blocks -> one packs event with stable ids; re-read after install clears it and translates", async () => {
		const s = await setup();
		s.runner.start();
		await s.at(2000);
		const first = packs(s.events);
		expect(first.length).toBe(1);
		const row = first[0]?.type === "packs" ? first[0].rows[0] : undefined;
		expect(row?.lang).toBe(languageCode("ja"));
		expect(row?.segmentIds).toEqual(["L1"]);
		expect(s.runner.status).toBe("live");
		// Unchanged screen: no OCR, no repeated packs event.
		expect(s.ocr.calls.length).toBe(1);

		s.install();
		s.runner.invalidate();
		await s.at(4000);
		expect(s.ocr.calls.length).toBe(2);
		const all = packs(s.events);
		expect(all.length).toBe(2);
		expect(all[1]?.type === "packs" ? all[1].rows : null).toEqual([]);
		const translated = s.events.filter((e) => e.type === "translation" && e.final && !e.failed);
		expect(translated.map((e) => (e.type === "translation" ? e.id : ""))).toEqual(["L1"]);
		s.runner.stop();
	});
});
