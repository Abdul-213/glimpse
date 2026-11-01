// GLIM-48: the Live capture loop on a manual clock over recorded (in-memory) frame sequences.
import { describe, expect, test } from "bun:test";
import {
	CaptureError,
	type CaptureFrame,
	clampLiveFps,
	LIVE_FPS,
	type LiveCaptureFailure,
	LiveCaptureLoop,
	type LiveFrameSource,
	type LiveTickInfo,
	rect,
} from "@glimpse/core";
import { ManualTimers, ReplayCaptureSource, solidImage } from "@glimpse/core/testing";

const A = solidImage(40, 20, [10, 10, 10]);
const B = solidImage(40, 20, [200, 200, 200]);

/** A timed recording on the manual clock: the frame on screen depends on elapsed time. */
async function timedSession(
	timers: ManualTimers,
	frames: { image: typeof A; holdMs: number }[],
	end: "hold" | "loop" = "hold",
) {
	const source = new ReplayCaptureSource(frames, { advance: "timed", now: timers.now, end });
	return source.openSession(rect(0, 0, 40, 20), { fps: 3 });
}

interface Seen {
	readonly at: number;
	readonly sequence: number;
	readonly info: LiveTickInfo;
}

function recorder(timers: ManualTimers, wake?: (f: CaptureFrame) => number | undefined) {
	const seen: Seen[] = [];
	const errors: LiveCaptureFailure[] = [];
	return {
		seen,
		errors,
		handler: {
			onFrame: (frame: CaptureFrame, info: LiveTickInfo) => {
				seen.push({ at: timers.now(), sequence: frame.sequence, info });
				return wake?.(frame);
			},
			onError: (e: LiveCaptureFailure) => errors.push(e),
		},
	};
}

describe("clampLiveFps", () => {
	test("keeps the rate within 2-4 fps", () => {
		expect(clampLiveFps(3)).toBe(3);
		expect(clampLiveFps(0.5)).toBe(LIVE_FPS.min);
		expect(clampLiveFps(10)).toBe(LIVE_FPS.max);
		expect(clampLiveFps(Number.NaN)).toBe(LIVE_FPS.default);
	});
});

describe("LiveCaptureLoop", () => {
	test.each([2, 3, 4])("grabs at %d fps on a changing recording", async (fps) => {
		const timers = new ManualTimers();
		// Changes every 100 ms, so the loop never backs off.
		const frames = Array.from({ length: 40 }, (_, i) => ({ image: i % 2 ? A : B, holdMs: 100 }));
		const session = await timedSession(timers, frames, "loop");
		const r = recorder(timers);
		const loop = new LiveCaptureLoop({ source: session, timers, handler: r.handler, fps });
		loop.start();
		await timers.advance(3000);
		loop.stop();
		// First grab at t=0, then every 1000/fps ms: 3 s -> 3*fps + 1 grabs.
		expect(r.seen.length).toBe(3 * fps + 1);
		const gaps = r.seen.slice(1).map((s, i) => s.at - (r.seen[i]?.at ?? 0));
		for (const g of gaps) expect(g).toBeCloseTo(1000 / fps, 5);
		expect(r.seen[0]?.info.fresh).toBe(true);
		expect(r.seen[1]?.info.fresh).toBe(false);
	});

	test("fps outside 2-4 is clamped, and setFps applies from the next grab", async () => {
		const timers = new ManualTimers();
		const frames = Array.from({ length: 60 }, (_, i) => ({ image: i % 2 ? A : B, holdMs: 50 }));
		const session = await timedSession(timers, frames, "loop");
		const r = recorder(timers);
		const loop = new LiveCaptureLoop({ source: session, timers, handler: r.handler, fps: 30 });
		expect(loop.fps).toBe(4);
		loop.start();
		await timers.advance(1000); // t=0,250,500,750,1000
		expect(r.seen.length).toBe(5);
		loop.setFps(2);
		await timers.advance(2000); // next grab at 1250 (already scheduled), then every 500
		expect(r.seen.map((s) => s.at)).toEqual([0, 250, 500, 750, 1000, 1250, 1750, 2250, 2750]);
	});

	test("backs off to 2 fps after 2 s without new content, and snaps back on change", async () => {
		const timers = new ManualTimers();
		// A for 5 s, then B.
		const session = await timedSession(timers, [
			{ image: A, holdMs: 5000 },
			{ image: B, holdMs: 10_000 },
		]);
		const r = recorder(timers);
		const loop = new LiveCaptureLoop({ source: session, timers, handler: r.handler, fps: 4 });
		loop.start();
		await timers.advance(7000);
		loop.stop();
		const times = r.seen.map((s) => s.at);
		// 4 fps up to the 2 s idle mark, then 500 ms steps (2 fps, the bottom of the Live range);
		// B appears at 5 s, seen at the 5 s grab, then 4 fps again until 2 s idle.
		expect(times.slice(0, 9)).toEqual([0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000]);
		expect(times.filter((t) => t > 2000 && t < 5000)).toEqual([2500, 3000, 3500, 4000, 4500]);
		const firstB = r.seen.find((s) => s.info.sequenceChanged && s.at > 0);
		expect(firstB?.at).toBe(5000);
		expect(times).toContain(5250);
		expect(times).toContain(5500);
		expect(loop.stats().newFrames).toBe(2);
	});

	test("a wake hint brings the next grab forward, but never below minPeriodMs", async () => {
		const timers = new ManualTimers();
		const session = await timedSession(timers, [{ image: A, holdMs: 1000 }]);
		const r = recorder(timers, () => 120);
		const loop = new LiveCaptureLoop({ source: session, timers, handler: r.handler, fps: 2, minPeriodMs: 100 });
		loop.start();
		await timers.advance(500);
		loop.stop();
		expect(r.seen.map((s) => s.at)).toEqual([0, 120, 240, 360, 480]);
	});

	test("pause stops grabbing at once and drops a grab in flight; resume grabs at once", async () => {
		const timers = new ManualTimers();
		let release: (() => void) | null = null;
		let calls = 0;
		const source: LiveFrameSource = {
			next: async () => {
				calls++;
				if (calls === 3) await new Promise<void>((r) => (release = r));
				return {
					width: 1,
					height: 1,
					data: new Uint8Array(4),
					rect: rect(0, 0, 1, 1),
					scale: 1,
					displayIds: [1],
					partial: false,
					sequence: calls,
					capturedAt: timers.now(),
				};
			},
		};
		const r = recorder(timers);
		const loop = new LiveCaptureLoop({ source, timers, handler: r.handler, fps: 4 });
		loop.start();
		await timers.advance(500); // grabs at 0, 250; the 500 grab hangs
		expect(r.seen.length).toBe(2);
		loop.pause();
		(release as (() => void) | null)?.();
		await timers.advance(2000);
		expect(r.seen.length).toBe(2); // the hung grab's frame was dropped, nothing new
		expect(loop.state).toBe("paused");
		loop.resume();
		await timers.advance(0);
		expect(r.seen.length).toBe(3);
		expect(r.seen[2]?.at).toBe(2500);
		expect(r.seen[2]?.info.fresh).toBe(true);
		loop.stop();
	});

	test("transient capture errors retry with backoff; fatal ones pause until resume", async () => {
		const timers = new ManualTimers();
		let mode: "ok" | "locked" | "gone" = "ok";
		let seq = 0;
		const source: LiveFrameSource = {
			next: async () => {
				if (mode === "locked") throw new CaptureError("temporarily-unavailable", "secure desktop");
				if (mode === "gone") throw new CaptureError("no-display", "display removed");
				return {
					width: 1,
					height: 1,
					data: new Uint8Array(4),
					rect: rect(0, 0, 1, 1),
					scale: 1,
					displayIds: [1],
					partial: false,
					sequence: ++seq,
					capturedAt: timers.now(),
				};
			},
		};
		const r = recorder(timers);
		const loop = new LiveCaptureLoop({
			source,
			timers,
			handler: r.handler,
			fps: 4,
			retry: { baseMs: 500, maxMs: 2000 },
		});
		loop.start();
		await timers.advance(0);
		mode = "locked";
		await timers.advance(5000);
		expect(r.errors.map((e) => e.retryInMs)).toEqual([500, 1000, 2000, 2000]);
		expect(r.errors.every((e) => !e.fatal && e.code === "temporarily-unavailable")).toBe(true);
		mode = "ok";
		await timers.advance(2000);
		const recovered = r.seen.find((s) => s.at > 0);
		expect(recovered?.info.fresh).toBe(true);
		mode = "gone";
		await timers.advance(1000);
		const last = r.errors.at(-1);
		expect(last?.fatal).toBe(true);
		expect(last?.code).toBe("no-display");
		expect(loop.state).toBe("paused");
		const errorsBefore = r.errors.length;
		await timers.advance(5000);
		expect(r.errors.length).toBe(errorsBefore);
		mode = "ok";
		loop.resume();
		await timers.advance(0);
		expect(loop.state).toBe("running");
		loop.stop();
	});

	test("reports how late a timer fired (system sleep)", async () => {
		const timers = new ManualTimers();
		const session = await timedSession(timers, [{ image: A, holdMs: 1000 }]);
		const r = recorder(timers);
		const loop = new LiveCaptureLoop({ source: session, timers, handler: r.handler, fps: 4 });
		loop.start();
		await timers.advance(0);
		timers.jump(60_000); // asleep: the next timer was due at 250
		await timers.advance(0);
		expect(r.seen.at(-1)?.info.lateMs).toBe(60_000 - 250);
		loop.stop();
	});

	test("stats count grabs and new frames", async () => {
		const timers = new ManualTimers();
		const session = await timedSession(timers, [
			{ image: A, holdMs: 500 },
			{ image: B, holdMs: 500 },
		]);
		const r = recorder(timers);
		const loop = new LiveCaptureLoop({ source: session, timers, handler: r.handler, fps: 4 });
		loop.start();
		await timers.advance(1000);
		loop.stop();
		const s = loop.stats();
		expect(s.grabs).toBe(5);
		expect(s.newFrames).toBe(2);
		expect(s.state).toBe("stopped");
	});
});
