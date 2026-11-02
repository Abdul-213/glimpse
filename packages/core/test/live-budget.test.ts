// GLIM-66: the Live CPU budget (rolling average, levels up and down) and the runner's back-off.
import { describe, expect, test } from "bun:test";
import {
	LIVE_BUDGET_DEFAULTS,
	LIVE_BUDGET_LEVELS,
	LiveBudget,
	type LiveBudgetState,
	LivePipelineSession,
	LiveRunner,
	type LiveTrace,
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

describe("LiveBudget", () => {
	const opts = { shareOfCore: 0.2, windowMs: 10_000, relaxAfterMs: 20_000 };

	test("no decision until the window has filled; over budget steps up and restarts the window", () => {
		const b = new LiveBudget(opts);
		// 40 % of a core: 400 ms of CPU per second.
		let changed: LiveBudgetState | null = null;
		for (let t = 0; t <= 9_000; t += 1000) expect(b.sample(t, t * 0.4)).toBeNull();
		for (let t = 10_000; t <= 10_000; t += 1000) changed = b.sample(t, t * 0.4);
		expect(changed).toMatchObject({ level: 1, limits: LIVE_BUDGET_LEVELS[1] });
		expect(b.state().share).toBeCloseTo(0.4, 5);
		// The next step needs a full new window at the new level.
		for (let t = 11_000; t < 20_000; t += 1000) expect(b.sample(t, t * 0.4)).toBeNull();
		expect(b.sample(20_000, 20_000 * 0.4)?.level).toBe(2);
	});

	test("under budget never steps up; the top level is the limit", () => {
		const b = new LiveBudget(opts);
		for (let t = 0; t <= 60_000; t += 1000) expect(b.sample(t, t * 0.1)).toBeNull();
		const hot = new LiveBudget(opts);
		for (let t = 0; t <= 120_000; t += 1000) hot.sample(t, t * 0.9);
		expect(hot.state().level).toBe(LIVE_BUDGET_LEVELS.length - 1);
	});

	test("steps back down after staying under half the budget for relaxAfterMs", () => {
		const b = new LiveBudget(opts);
		let cpu = 0;
		let t = 0;
		const run = (ms: number, share: number) => {
			const changes: number[] = [];
			for (const end = t + ms; t < end; ) {
				t += 1000;
				cpu += 1000 * share;
				const c = b.sample(t, cpu);
				if (c) changes.push(c.level);
			}
			return changes;
		};
		expect(run(11_000, 0.5)).toEqual([1]);
		// Between half the budget and the budget: stay.
		expect(run(40_000, 0.15)).toEqual([]);
		// Under half: down one level once it has lasted 20 s (after the window refilled).
		expect(run(40_000, 0.05)).toEqual([0]);
		expect(b.state().level).toBe(0);
	});

	test("restart forgets the readings", () => {
		const b = new LiveBudget(opts);
		for (let t = 0; t < 9_000; t += 1000) b.sample(t, t * 0.9);
		b.restart();
		for (let t = 9_000; t < 18_000; t += 1000) expect(b.sample(t, t * 0.9)).toBeNull();
	});

	test("defaults: 35 % of one core over 30 s", () => {
		expect(LIVE_BUDGET_DEFAULTS.shareOfCore).toBe(0.35);
		expect(LIVE_BUDGET_DEFAULTS.windowMs).toBe(30_000);
		expect(LIVE_BUDGET_LEVELS.map((l) => l.ocrGapMs)).toEqual([0, 1000, 2000, 3000]);
	});
});

describe("LiveRunner under the budget", () => {
	const W = 200;
	const H = 50;
	const COLOURS: readonly (readonly [number, number, number])[] = [
		[220, 40, 40],
		[40, 200, 40],
		[40, 40, 220],
		[220, 220, 40],
	];
	const strip = (i: number) =>
		makeImage(W, H, (x, y) =>
			y >= 10 && y < 40 && x >= 10 && x < 30 + ((i * 7) % 160) ? (COLOURS[i % 4] ?? [0, 0, 0]) : [20, 20, 20],
		);

	/** Content that changes every `everyMs`; OCR that "costs" `ocrCpuMs` of CPU per call. */
	async function setup(everyMs: number, ocrCpuMs: number, budget: false | undefined = undefined) {
		const timers = new ManualTimers(1_000_000);
		const ocr = new FakeOcrProvider({ blocks: () => [ocrBlock("b1", "テキスト", rect(10, 10, 180, 30))] });
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
		const frames = [];
		for (let i = 0; i < 400; i++) frames.push({ image: strip(i), holdMs: everyMs });
		const source = new ReplayCaptureSource(frames, { advance: "timed", now: timers.now });
		const capture = await source.openSession(rect(0, 0, W, H), { fps: 4 });
		const traces: LiveTrace[] = [];
		const levels: number[] = [];
		const runner = new LiveRunner({
			sessionId: "s1",
			region: rect(0, 0, W, H),
			source: capture,
			timers,
			processor: session,
			fps: 4,
			diffThreshold: 0.02,
			stabilityMs: 300,
			onEvent: () => {},
			onTrace: (t) => traces.push(t),
			cpuNow: () => ocr.calls.length * ocrCpuMs,
			onBudget: (s) => levels.push(s.level),
			...(budget === false ? { budget: false } : {}),
		});
		return { timers, ocr, runner, traces, levels };
	}

	test("content changing every second with expensive OCR: the runner backs off and spaces OCR runs", async () => {
		// 1 OCR per second x 600 ms = 60 % of a core, over the 35 % budget.
		const s = await setup(1000, 600);
		s.runner.start();
		await s.timers.advance(120_000);
		s.runner.stop();
		const stats = s.runner.stats();
		expect(s.levels[0]).toBe(1);
		expect(stats.budget?.level).toBeGreaterThanOrEqual(2);
		// After the back-off, OCR runs are at least the level's gap apart and the loop is at 2 fps.
		const ocrAt = s.traces.filter((t) => t.action === "ocr").map((t) => t.at);
		const late = ocrAt.filter((t) => t >= (ocrAt[0] ?? 0) + 80_000);
		for (let i = 1; i < late.length; i++)
			expect((late[i] as number) - (late[i - 1] as number)).toBeGreaterThanOrEqual(1999);
		expect(stats.loop.fps).toBe(2);
		// Without the budget the same content is read every second.
		const free = await setup(1000, 600, false);
		free.runner.start();
		await free.timers.advance(120_000);
		free.runner.stop();
		expect(free.ocr.calls.length).toBeGreaterThan(s.ocr.calls.length * 1.25);
		expect(free.runner.stats().budget).toBeNull();
	}, 30_000);

	test("content changing every 5 s stays at level 0 (every change read)", async () => {
		const s = await setup(5000, 600);
		s.runner.start();
		await s.timers.advance(120_000);
		s.runner.stop();
		expect(s.levels).toEqual([]);
		expect(s.ocr.calls.length).toBeGreaterThanOrEqual(24);
	}, 30_000);
});
