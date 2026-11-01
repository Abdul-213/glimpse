// GLIM-58 end to end in core: capture loop -> change detection -> frame ring -> pipeline ->
// block diff -> Live session events, on a manual clock over a recorded frame sequence.
import { describe, expect, test } from "bun:test";
import {
	CaptureError,
	type CaptureFrame,
	type LiveFrameSource,
	LivePipelineSession,
	LiveRunner,
	type LiveSessionEvent,
	type LiveTrace,
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
const H = 50;
type Rgb = readonly [number, number, number];
const BG: Rgb = [20, 20, 20];
const COLOURS = {
	red: [220, 40, 40],
	green: [40, 200, 40],
	blue: [40, 40, 220],
	yellow: [220, 220, 40],
	black: [0, 0, 0],
} as const satisfies Record<string, Rgb>;
type Colour = keyof typeof COLOURS;
const TEXT: Record<Colour, string> = {
	red: "こんにちは",
	green: "さようなら",
	blue: "ありがとう",
	yellow: "おはよう",
	black: "",
};

const strip = (c: Colour) =>
	c === "black"
		? makeImage(W, H, () => [0, 0, 0])
		: makeImage(W, H, (x, y) => (y >= 10 && y < 40 && x >= 10 && x < 190 ? COLOURS[c] : BG));

/** "Reads" the bar colour at (20, 20) and returns its text: OCR whose output follows the pixels. */
function colourOcr() {
	return new FakeOcrProvider({
		blocks: (req) => {
			const img: OcrImage = req.image;
			const i = 20 * img.stride + 20 * 4;
			const px = [img.data[i], img.data[i + 1], img.data[i + 2]];
			const colour = (Object.keys(COLOURS) as Colour[]).find((k) => COLOURS[k].every((v, n) => v === px[n]));
			const text = colour ? TEXT[colour] : "";
			return text ? [ocrBlock("b1", text, rect(10, 10, 180, 30))] : [];
		},
	});
}

async function setup(frames: { colour: Colour; holdMs: number }[], opts: { fps?: number; end?: "hold" | "loop" } = {}) {
	const timers = new ManualTimers(1_000_000);
	const ocr = colourOcr();
	await ocr.init();
	const translator = new FakeTranslationProvider({ capabilities: { streaming: false } });
	await translator.init();
	const pipeline = new TranslationPipeline({ ocr: () => ocr, chain: () => [translator], clock: timers });
	const caches = new TranslationCaches({ now: timers.now });
	const session = new LivePipelineSession({
		pipeline,
		caches,
		target: languageCode("en"),
		sources: [],
		private: false,
	});
	const source = new ReplayCaptureSource(
		frames.map((f) => ({ image: strip(f.colour), holdMs: f.holdMs, name: f.colour })),
		{ advance: "timed", now: timers.now, end: opts.end ?? "hold" },
	);
	const capture = await source.openSession(rect(0, 0, W, H), { fps: 3 });
	const events: LiveSessionEvent[] = [];
	const traces: LiveTrace[] = [];
	const runner = new LiveRunner({
		sessionId: "s1",
		region: rect(0, 0, W, H),
		source: capture,
		timers,
		processor: session,
		fps: opts.fps ?? 3,
		diffThreshold: 0.02,
		stabilityMs: 300,
		onEvent: (e) => events.push(e),
		onTrace: (t) => traces.push(t),
	});
	const t0 = timers.now();
	const at = (ms: number) => timers.advanceTo(t0 + ms);
	return { timers, ocr, translator, runner, events, traces, at, t0 };
}

const frames = (events: LiveSessionEvent[]) => events.filter((e) => e.type === "frame");
const statuses = (events: LiveSessionEvent[]) =>
	events.filter((e) => e.type === "status").map((e) => (e.type === "status" ? e.status : ""));

describe("LiveRunner (GLIM-58)", () => {
	test("static -> subtitle change -> fast flicker -> back -> A again -> new line: OCR only when expected", async () => {
		const flicker: { colour: Colour; holdMs: number }[] = [];
		for (let i = 0; i < 10; i++) flicker.push({ colour: i % 2 ? "yellow" : "blue", holdMs: 100 });
		const s = await setup([
			{ colour: "red", holdMs: 1000 }, // A static
			{ colour: "green", holdMs: 1000 }, // B: the subtitle changes
			...flicker, // fast flicker, never stable
			{ colour: "green", holdMs: 1000 }, // settles back on B: nothing to re-read
			{ colour: "red", holdMs: 1000 }, // A again: frame ring hit, no OCR
			{ colour: "blue", holdMs: 2000 }, // a new line: OCR
		]);
		s.runner.start();
		await s.at(7000);
		s.runner.stop();
		const stats = s.runner.stats();
		expect(s.ocr.calls.length).toBe(3);
		expect(stats.ocrRuns).toBe(3);
		expect(stats.ringHits).toBe(1);
		const acted = s.traces.filter((t) => t.action !== "none").map((t) => [Math.round(t.at - s.t0), t.action]);
		expect(acted.map(([, a]) => a)).toEqual(["ocr", "ocr", "reused", "ocr"]);
		// A at once. Each change is acted on once it has been still for 300 ms: the first grab
		// that sees it (at most one 333 ms period late), then a wake-up 300 ms later.
		const changes = [0, 1000, 4000, 5000];
		acted.forEach(([at], i) => {
			const change = changes[i] ?? 0;
			const lag = (at as number) - change;
			if (i === 0) expect(lag).toBe(0);
			else {
				expect(lag).toBeGreaterThanOrEqual(300);
				expect(lag).toBeLessThanOrEqual(300 + 334);
			}
		});
		// During the flicker every grab is "settling".
		const during = s.traces.filter((t) => t.at - s.t0 > 2000 && t.at - s.t0 < 3000);
		expect(during.length).toBeGreaterThan(0);
		expect(during.every((t) => t.decision === "settling")).toBe(true);
		// Back on B after the flicker: stable, but nothing changed vs what was read.
		expect(s.traces.some((t) => t.decision === "below-threshold")).toBe(true);
		// Events: first fill unmarked; then one changed block per change, same stable id.
		const f = frames(s.events);
		expect(f.map((e) => (e.type === "frame" ? [e.frameSeq, e.reused, e.changeSet] : null))).toEqual([
			[1, false, []],
			[2, false, ["L1"]],
			[3, true, ["L1"]],
			[4, false, ["L1"]],
		]);
		const first = f[0];
		expect(first?.type === "frame" ? first.upserts.map((u) => [u.id, u.source, u.changed]) : null).toEqual([
			["L1", "こんにちは", false],
		]);
		const reused = f[2];
		// The reused frame carries its translation (no translation events needed).
		expect(reused?.type === "frame" ? reused.upserts[0]?.translation : null).toBe("こんにちは [ja>en]");
		const translations = s.events.filter((e) => e.type === "translation" && e.final);
		expect(translations.map((e) => (e.type === "translation" ? [e.frameSeq, e.id, e.text] : null))).toEqual([
			[1, "L1", "こんにちは [ja>en]"],
			[2, "L1", "さようなら [ja>en]"],
			[4, "L1", "ありがとう [ja>en]"],
		]);
		expect(statuses(s.events)).toEqual(["starting", "live", "stopped"]);
		expect(stats.loop.fps).toBe(3);
	});

	test("pause stops capturing, marks the text stale; resume re-reads at once and marks what changed", async () => {
		const s = await setup([
			{ colour: "red", holdMs: 1000 },
			{ colour: "green", holdMs: 5000 },
		]);
		s.runner.start();
		await s.at(500);
		s.runner.pause("user");
		const grabs = s.runner.stats().grabs;
		await s.at(3000);
		expect(s.runner.stats().grabs).toBe(grabs); // nothing captured while paused
		const paused = s.events.findLast((e) => e.type === "status");
		expect(paused).toMatchObject({ status: "paused", reason: "user", stale: true, capturedAt: s.t0 });
		s.runner.resume();
		await s.at(3000);
		// The first grab after resume is compared with what was read: changed -> processed at once.
		const after = s.traces.filter((t) => t.at - s.t0 >= 3000);
		expect(after[0]).toMatchObject({ decision: "settled", reason: "resume", action: "ocr" });
		expect(frames(s.events).at(-1)).toMatchObject({ changeSet: ["L1"] });
		expect(statuses(s.events)).toEqual(["starting", "live", "paused", "live"]);
		s.runner.stop();
	});

	test("an automatic resume (unlock) never undoes a user pause", async () => {
		const s = await setup([{ colour: "red", holdMs: 1000 }]);
		s.runner.start();
		await s.at(0);
		s.runner.pause("user");
		s.runner.pause("locked");
		s.runner.resume("locked");
		expect(s.runner.status).toBe("paused");
		expect(s.runner.pauseReason).toBe("user");
		s.runner.resume();
		expect(s.runner.status).toBe("live");
		s.runner.stop();
	});

	test("no text: short gaps keep the last blocks; after 5 s the session is empty", async () => {
		const s = await setup([
			{ colour: "red", holdMs: 1000 },
			{ colour: "black", holdMs: 2000 }, // fade to black between lines
			{ colour: "red", holdMs: 1000 },
			{ colour: "black", holdMs: 8000 },
		]);
		s.runner.start();
		await s.at(3500);
		// The 2 s gap: blank frame skipped, no removes, still "live".
		expect(frames(s.events).every((e) => e.type === "frame" && e.removes.length === 0)).toBe(true);
		expect(s.runner.status).toBe("live");
		await s.at(12_000);
		const last = frames(s.events).at(-1);
		expect(last).toMatchObject({ removes: ["L1"], order: [] });
		expect(s.runner.status).toBe("empty");
		expect(s.runner.stats().blankFrames).toBe(2);
		expect(s.ocr.calls.length).toBe(1); // black frames never reach OCR; red again was a ring hit
		s.runner.stop();
	});

	test("'Updating' after 1 s of processing a settled change", async () => {
		const s = await setup([
			{ colour: "red", holdMs: 1000 },
			{ colour: "green", holdMs: 5000 },
		]);
		let release: () => void = () => {};
		const slow = new Promise<void>((r) => (release = r));
		const original = s.ocr.recognise.bind(s.ocr);
		let n = 0;
		s.ocr.recognise = async (req, opts) => {
			if (++n === 2) await slow;
			return original(req, opts);
		};
		s.runner.start();
		await s.at(2000);
		expect(s.runner.status).toBe("live");
		await s.at(2400); // settled at 1300 + 1000 ms
		expect(s.runner.status).toBe("updating");
		release();
		await s.at(2500);
		expect(s.runner.status).toBe("live");
		expect(statuses(s.events)).toEqual(["starting", "live", "updating", "live"]);
		s.runner.stop();
	});

	test("fatal capture errors pause with an error kind; transient ones show 'paused' and recover by themselves", async () => {
		const timers = new ManualTimers();
		let mode: "ok" | "locked" | "gone" = "ok";
		let seq = 0;
		const img = strip("red");
		const source: LiveFrameSource = {
			next: async (): Promise<CaptureFrame> => {
				if (mode === "locked") throw new CaptureError("temporarily-unavailable", "secure desktop");
				if (mode === "gone") throw new CaptureError("no-display", "display removed");
				return {
					...img,
					rect: rect(0, 0, W, H),
					scale: 1,
					displayIds: [1],
					partial: false,
					sequence: ++seq,
					capturedAt: timers.now(),
				};
			},
		};
		const events: LiveSessionEvent[] = [];
		const runner = new LiveRunner({
			sessionId: "s2",
			region: rect(0, 0, W, H),
			source,
			timers,
			processor: { process: async () => null },
			fps: 4,
			diffThreshold: 0.02,
			stabilityMs: 300,
			onEvent: (e) => events.push(e),
		});
		runner.start();
		await timers.advance(0);
		mode = "locked";
		await timers.advance(2000);
		expect(runner.status).toBe("paused");
		expect(runner.pauseReason).toBe("unavailable");
		mode = "ok";
		await timers.advance(3000);
		expect(runner.status).toBe("starting"); // nothing was read yet (the processor returns null)
		mode = "gone";
		await timers.advance(1000);
		expect(runner.status).toBe("error");
		expect(events.findLast((e) => e.type === "status")).toMatchObject({
			status: "error",
			error: { kind: "areaGone" },
			stale: true,
		});
		runner.stop();
	});

	test("OCR failure pauses with ocrFailed; resume tries again", async () => {
		const s = await setup([{ colour: "red", holdMs: 5000 }]);
		let fail = true;
		const original = s.ocr.recognise.bind(s.ocr);
		s.ocr.recognise = async (req, opts) => {
			if (fail) throw new Error("engine crashed");
			return original(req, opts);
		};
		s.runner.start();
		await s.at(100);
		expect(s.runner.status).toBe("error");
		expect(s.events.findLast((e) => e.type === "status")).toMatchObject({ error: { kind: "ocrFailed" } });
		fail = false;
		s.runner.resume();
		await s.at(200);
		// The resumed grab equals the baseline (the failed frame), so it is below threshold.
		// Invalidate forces a re-read, as after a settings change.
		s.runner.invalidate();
		await s.at(1000);
		expect(frames(s.events).length).toBe(1);
		expect(s.runner.status).toBe("live");
		s.runner.stop();
	});

	test("settings changes apply without restarting", async () => {
		const s = await setup([{ colour: "red", holdMs: 10_000 }]);
		s.runner.start();
		await s.at(1000);
		s.runner.setParams({ fps: 2, stabilityMs: 500, diffThreshold: 0.1 });
		expect(s.runner.stats().loop.fps).toBe(2);
		s.runner.stop();
	});
});
