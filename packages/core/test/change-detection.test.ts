// GLIM-58: pixel diff + stability debounce on recorded frame sequences, and the GLIM-20 frame ring.
import { describe, expect, test } from "bun:test";
import {
	type CaptureFrame,
	type ChangeDecision,
	ChangeDetector,
	diffFrames,
	FrameRing,
	frameKey,
	rect,
} from "@glimpse/core";
import { ManualTimers, makeImage, ReplayCaptureSource } from "@glimpse/core/testing";

const W = 200;
const H = 50;
const BG = [20, 20, 20] as const;

/** A 200x50 "subtitle strip": a text bar of `colour`, `width` px wide, plus an optional caret. */
function strip(colour: readonly [number, number, number], width = 180, caret = false) {
	return makeImage(W, H, (x, y) => {
		if (caret && x === 195 && y >= 10 && y < 20) return [255, 255, 255];
		return y >= 10 && y < 40 && x >= 10 && x < 10 + width ? colour : BG;
	});
}

const RED = [220, 40, 40] as const;
const GREEN = [40, 200, 40] as const;
const BLUE = [40, 40, 220] as const;

/** Feed a timed recording to a detector, grabbing every `periodMs` (no wake hints). */
async function run(frames: { image: ReturnType<typeof strip>; holdMs: number }[], periodMs: number, untilMs: number) {
	const timers = new ManualTimers();
	const source = new ReplayCaptureSource(frames, { advance: "timed", now: timers.now });
	const session = await source.openSession(rect(0, 0, W, H), { fps: 3 });
	const detector = new ChangeDetector({ diffThreshold: 0.02, stabilityMs: 300 });
	const out: { at: number; d: ChangeDecision }[] = [];
	for (let t = 0; t <= untilMs; t += periodMs) {
		await timers.advanceTo(t);
		const f = await session.next();
		out.push({ at: t, d: detector.feed(f) });
	}
	return { out, detector, processed: out.filter((o) => o.d.kind === "first" || o.d.kind === "settled") };
}

describe("diffFrames", () => {
	test("fraction and box of changed pixels", () => {
		const a = strip(RED);
		const b = strip(RED, 90);
		const d = diffFrames(a, b);
		// The bar's right half (90 x 30 px) turned background.
		expect(d.fraction).toBeCloseTo((90 * 30) / (W * H), 5);
		expect(d.box).toEqual(rect(100, 10, 90, 30));
		expect(diffFrames(a, a)).toEqual({ fraction: 0, sampled: W * H, box: null });
	});

	test("tolerance ignores small noise; stride samples less", () => {
		const a = makeImage(10, 10, () => [100, 100, 100]);
		const b = makeImage(10, 10, () => [110, 95, 100]);
		expect(diffFrames(a, b).fraction).toBe(0);
		expect(diffFrames(a, b, { tolerance: 4 }).fraction).toBe(1);
		expect(diffFrames(a, b, { tolerance: 4, stride: 2 }).sampled).toBe(25);
	});

	test("different sizes count as fully changed", () => {
		expect(
			diffFrames(
				makeImage(2, 2, () => [0, 0, 0]),
				makeImage(3, 2, () => [0, 0, 0]),
			).fraction,
		).toBe(1);
	});
});

describe("ChangeDetector", () => {
	test("first frame is processed at once; a change is processed once stable for 300 ms", async () => {
		const { out, processed } = await run(
			[
				{ image: strip(RED), holdMs: 1000 },
				{ image: strip(GREEN), holdMs: 2000 },
			],
			250,
			2500,
		);
		expect(out[0]?.d.kind).toBe("first");
		expect(out.slice(1, 4).map((o) => o.d.kind)).toEqual(["same", "same", "same"]);
		// GREEN appears at 1000: moving at 1000, waiting at 1250 (250 ms < 300), settled at 1500.
		expect(out.find((o) => o.at === 1000)?.d).toMatchObject({ kind: "settling", reason: "moving", wakeInMs: 300 });
		expect(out.find((o) => o.at === 1250)?.d).toMatchObject({ kind: "settling", reason: "waiting", wakeInMs: 50 });
		expect(out.find((o) => o.at === 1500)?.d).toMatchObject({ kind: "settled", trigger: "stable", stableForMs: 500 });
		expect(processed.map((p) => p.at)).toEqual([0, 1500]);
		expect(out.slice(-3).every((o) => o.d.kind === "same")).toBe(true);
	});

	test("no re-OCR while the text is animating (typewriter): one settle after it stops", async () => {
		const frames = [{ image: strip(RED), holdMs: 600 }];
		for (let w = 20; w <= 180; w += 20) frames.push({ image: strip(BLUE, w), holdMs: 100 });
		frames.push({ image: strip(BLUE, 180), holdMs: 2000 });
		const { out, processed } = await run(frames, 100, 2500);
		const animating = out.filter((o) => o.at >= 600 && o.at < 1500);
		expect(animating.every((o) => o.d.kind === "settling")).toBe(true);
		// Typing ends at 1500 (last step shown 1400-1500 equals the final frame): stable 300 ms later.
		expect(processed.map((p) => p.at)).toEqual([0, 1700]);
	});

	test("no re-OCR while scrolling: each grab moves, settles after the scroll stops", async () => {
		const scrolled = (dy: number) =>
			makeImage(W, H, (x, y) => ((y + dy) % 10 < 4 && x > 10 && x < 190 ? [230, 230, 230] : [20, 20, 20]));
		const frames = [{ image: scrolled(0), holdMs: 500 }];
		for (let dy = 1; dy <= 8; dy++) frames.push({ image: scrolled(dy), holdMs: 125 });
		frames.push({ image: scrolled(8), holdMs: 2000 });
		const { processed } = await run(frames, 125, 2500);
		expect(processed.map((p) => p.at)).toEqual([0, 1750]);
	});

	test("a blinking caret (below the motion threshold) never re-runs OCR", async () => {
		const frames = [];
		for (let i = 0; i < 8; i++) frames.push({ image: strip(RED, 180, i % 2 === 1), holdMs: 500 });
		const { out, processed, detector } = await run(frames, 250, 4000);
		expect(processed.map((p) => p.at)).toEqual([0]);
		expect(out.some((o) => o.d.kind === "below-threshold")).toBe(true);
		expect(detector.stats().settled).toBe(0);
	});

	test("fast flicker never settles; when it ends on the processed content nothing re-runs", async () => {
		const frames = [{ image: strip(RED), holdMs: 1000 }];
		for (let i = 0; i < 10; i++) frames.push({ image: strip(i % 2 ? GREEN : BLUE), holdMs: 100 });
		frames.push({ image: strip(RED), holdMs: 2000 });
		const { out, processed } = await run(frames, 100, 3500);
		expect(out.filter((o) => o.at >= 1000 && o.at < 2000).every((o) => o.d.kind === "settling")).toBe(true);
		expect(processed.map((p) => p.at)).toEqual([0]);
		expect(out.find((o) => o.at === 2300)?.d.kind).toBe("below-threshold");
	});

	test("diffThreshold is configurable at runtime", async () => {
		const small = makeImage(W, H, (x, y) => (x < 20 && y < 20 ? [255, 255, 255] : BG)); // 4 % of pixels
		const base = makeImage(W, H, () => BG);
		const frames = { a: { ...stamp(base, 1) }, b: { ...stamp(small, 2) } };
		const d = new ChangeDetector({ diffThreshold: 0.05, stabilityMs: 0 });
		expect(d.feed(frames.a).kind).toBe("first");
		expect(d.feed({ ...frames.b, capturedAt: 100 }).kind).toBe("settling");
		expect(d.feed({ ...frames.b, capturedAt: 200 }).kind).toBe("below-threshold");
		d.setOptions({ diffThreshold: 0.03 });
		expect(d.feed({ ...frames.a, capturedAt: 300 }).kind).toBe("settling");
		expect(d.feed({ ...frames.b, capturedAt: 400 }).kind).toBe("settling");
		expect(d.feed({ ...frames.b, capturedAt: 500 }).kind).toBe("settled");
	});

	test("stabilityMs is configurable", () => {
		const d = new ChangeDetector({ diffThreshold: 0.02, stabilityMs: 1000 });
		const a = stamp(strip(RED), 1);
		const b = stamp(strip(GREEN), 2);
		d.feed(a);
		expect(d.feed({ ...b, capturedAt: 100 }).kind).toBe("settling");
		expect(d.feed({ ...b, capturedAt: 600 }).kind).toBe("settling");
		expect(d.feed({ ...b, capturedAt: 1100 }).kind).toBe("settled");
	});

	test("resume compares with the processed frame at once; reset starts over", () => {
		const d = new ChangeDetector({ diffThreshold: 0.02, stabilityMs: 300 });
		const a = stamp(strip(RED), 1);
		const b = stamp(strip(GREEN), 2);
		d.feed(a);
		d.resume();
		expect(d.feed({ ...b, capturedAt: 5000 })).toMatchObject({ kind: "settled", trigger: "resume" });
		d.resume();
		expect(d.feed({ ...b, sequence: 3, capturedAt: 6000 }).kind).toBe("below-threshold");
		d.reset();
		expect(d.feed({ ...b, sequence: 4, capturedAt: 7000 }).kind).toBe("first");
	});

	test("same-sequence frames cost no diff", () => {
		const d = new ChangeDetector({ diffThreshold: 0.02, stabilityMs: 300 });
		const a = stamp(strip(RED), 7);
		d.feed(a);
		for (let i = 1; i <= 20; i++)
			expect(d.feed({ ...a, data: new Uint8Array(a.data), capturedAt: i * 250 }).kind).toBe("same");
		expect(d.stats().diffs).toBe(0);
	});
});

describe("frame ring (GLIM-20)", () => {
	test("frameKey is exact: same pixels same key, one pixel off a different key", () => {
		const a = strip(RED);
		const b = strip(RED);
		expect(frameKey(a)).toBe(frameKey(b));
		b.data[4 * 1000] = 21;
		expect(frameKey(a)).not.toBe(frameKey(b));
		expect(frameKey(a)).toMatch(/^200x50:[0-9a-f]{16}$/);
	});

	test("keeps the last 8 distinct frames, most recently used", () => {
		const ring = new FrameRing<number>(8);
		for (let i = 0; i < 10; i++) ring.set(`k${i}`, i);
		expect(ring.size).toBe(8);
		expect(ring.get("k0")).toBeUndefined();
		expect(ring.get("k2")).toBe(2);
		ring.set("k10", 10); // evicts k3 (k2 was just used)
		expect(ring.get("k3")).toBeUndefined();
		expect(ring.get("k2")).toBe(2);
		ring.clear();
		expect(ring.size).toBe(0);
	});
});

function stamp(img: ReturnType<typeof strip>, sequence: number): CaptureFrame {
	return {
		...img,
		rect: rect(0, 0, img.width, img.height),
		scale: 1,
		displayIds: [1],
		partial: false,
		sequence,
		capturedAt: 0,
	};
}
