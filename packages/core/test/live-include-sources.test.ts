// GLIM-131: "Translate these" on the Live skipped line. The skipped languages become sources
// for the rest of the session (settings untouched): after a re-read the block is translated,
// without a change mark, and a later Settings change to the subset keeps the override.
import { describe, expect, test } from "bun:test";
import {
	LivePipelineSession,
	LiveRunner,
	type LiveSessionEvent,
	languageCode,
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

const ES = languageCode("es");
const DE = languageCode("de");
const JA = languageCode("ja");

async function setup() {
	const timers = new ManualTimers(1_000_000);
	const ocr = new FakeOcrProvider({ blocks: () => [ocrBlock("b1", "こんにちは", rect(10, 10, 180, 30))] });
	await ocr.init();
	const translator = new FakeTranslationProvider({ capabilities: { streaming: false } });
	await translator.init();
	const pipeline = new TranslationPipeline({ ocr: () => ocr, chain: () => [translator], clock: timers });
	const session = new LivePipelineSession({
		pipeline,
		caches: new TranslationCaches({ now: timers.now }),
		target: languageCode("en"),
		sources: [ES],
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
	return { session, runner, events, at: (ms: number) => timers.advanceTo(t0 + ms) };
}

const classes = (events: LiveSessionEvent[]) =>
	events.flatMap((e) => (e.type === "frame" ? e.upserts.map((u) => `${u.id}:${u.cls}:${u.changed}`) : []));

describe("Live 'Translate these' (GLIM-131)", () => {
	test("session sources: the subset plus the included languages; empty stays empty", async () => {
		const { session } = await setup();
		expect(session.sources).toEqual([ES]);
		session.includeSources([JA, JA]);
		expect(session.sources).toEqual([ES, JA]);
		session.setSources([DE]);
		expect(session.sources).toEqual([DE, JA]);
		session.setSources([]);
		expect(session.sources).toEqual([]);
	});

	test("the skipped block is translated after include + re-read, silently", async () => {
		const s = await setup();
		s.runner.start();
		await s.at(1500);
		expect(classes(s.events)).toEqual(["L1:skip:false"]);
		s.session.includeSources([JA]);
		s.runner.invalidate();
		await s.at(3000);
		expect(classes(s.events)).toEqual(["L1:skip:false", "L1:translate:false"]);
		const done = s.events.filter((e) => e.type === "translation" && e.final && !e.failed);
		expect(done.map((e) => (e.type === "translation" ? e.id : ""))).toEqual(["L1"]);
		s.runner.stop();
	});
});
