// GLIM-114: Live change detection over a moving background (text focus, stillness map).
import { describe, expect, test } from "bun:test";
import { type ChangeDecision, ChangeDetector, diffFrames, rect, StillnessMap } from "@glimpse/core";
import { ManualTimers, makeImage, ReplayCaptureSource } from "@glimpse/core/testing";

const W = 200;
const H = 60;
type Rgb = readonly [number, number, number];
type Img = ReturnType<typeof makeImage>;

/** A "video" frame: 4 px cells whose colour changes every frame (every pixel moves). */
const videoAt =
	(frame: number) =>
	(x: number, y: number): Rgb => {
		const c = ((Math.floor(x / 4) * 7 + Math.floor(y / 4) * 13 + frame * 101) * 2654435761) >>> 0;
		return [40 + (c % 150), 40 + ((c >>> 8) % 150), 40 + ((c >>> 16) % 150)];
	};

/** Glyph-like vertical strokes in the subtitle band: subtitle `id` draws a different pattern, `chars` of them. */
const glyph =
	(id: number, chars = 10) =>
	(x: number, y: number): boolean =>
		y >= 24 && y < 40 && x >= 40 && x < 40 + chars * 12 && (x - 40 + id * 4) % 12 < 4;

function subtitleFrame(video: number, id: number | null, chars = 10): Img {
	const bg = videoAt(video);
	const g = id === null ? null : glyph(id, chars);
	return makeImage(W, H, (x, y) => (g?.(x, y) ? [255, 255, 255] : bg(x, y)));
}

/** Moving video around a static dark dialogue box (game dialogue), with `chars` typed. */
function dialogueFrame(video: number, chars: number): Img {
	const bg = videoAt(video);
	const g = glyph(1, chars);
	return makeImage(W, H, (x, y) => {
		if (y >= 16 && y < 48 && x >= 30 && x < 190) return g(x, y) ? [240, 240, 240] : [10, 12, 30];
		return bg(x, y);
	});
}

/**
 * Replay `frameAt(t)` sampled every `stepMs` (the "video" rate) and grab every `grabMs`,
 * feeding a detector; `onProcess` gets the processed frames' times (to set text areas).
 */
async function run(
	frameAt: (t: number) => Img,
	opts: {
		untilMs: number;
		stepMs?: number;
		grabMs?: number;
		detector?: ChangeDetector;
		areas?: Parameters<ChangeDetector["setTextAreas"]>[0];
	},
) {
	const stepMs = opts.stepMs ?? 125;
	const grabMs = opts.grabMs ?? 250;
	const frames = [];
	for (let t = 0; t < opts.untilMs + stepMs; t += stepMs) frames.push({ image: frameAt(t), holdMs: stepMs });
	const timers = new ManualTimers();
	const source = new ReplayCaptureSource(frames, { advance: "timed", now: timers.now });
	const session = await source.openSession(rect(0, 0, W, H), { fps: 4 });
	const detector = opts.detector ?? new ChangeDetector({ diffThreshold: 0.02, stabilityMs: 300 });
	const out: { at: number; d: ChangeDecision }[] = [];
	for (let t = 0; t <= opts.untilMs; t += grabMs) {
		await timers.advanceTo(t);
		const d = detector.feed(await session.next());
		if ((d.kind === "first" || d.kind === "settled") && opts.areas) detector.setTextAreas(opts.areas);
		out.push({ at: t, d });
	}
	return {
		out,
		detector,
		processed: out.filter((o) => o.d.kind === "first" || o.d.kind === "settled").map((o) => o.at),
	};
}

/** The subtitle band's box (what OCR would report). */
const SUBTITLE_BOX = rect(40, 24, 120, 16);

describe("StillnessMap", () => {
	test("its motion diff is exactly diffFrames' (fraction and box), at any stride", () => {
		const a = subtitleFrame(0, 1);
		const b = subtitleFrame(1, 2);
		for (const stride of [1, 2]) {
			const map = new StillnessMap(W, H, stride, 0);
			const c = map.track(b, a, 100, 0, 300, 24);
			expect(c.motion).toEqual(diffFrames(b, a, { tolerance: 24, stride }));
		}
	});

	test("still pixels, changes of still pixels and arrivals", () => {
		const map = new StillnessMap(W, H, 1, 0);
		const a = subtitleFrame(0, 1);
		// 0 -> 400: the subtitle pixels hold still, the video moves.
		map.track(subtitleFrame(1, 1), a, 200, 0, 300, 24);
		const c1 = map.track(subtitleFrame(2, 1), subtitleFrame(1, 1), 400, 200, 300, 24);
		const subtitlePx = [...Array(W * H).keys()].filter((i) => glyph(1)(i % W, Math.floor(i / W))).length;
		expect(c1.arrivals).toBeGreaterThanOrEqual(subtitlePx);
		expect(c1.arrivals).toBeLessThan(subtitlePx * 1.2);
		// Subtitle 2 replaces it: the still subtitle pixels that are now video changed.
		const c2 = map.track(subtitleFrame(3, 2), subtitleFrame(2, 1), 600, 400, 300, 24);
		expect(c2.stillChanged).toBeGreaterThan(0);
		// Watching only the left half halves what is counted.
		map.setWatch([rect(0, 0, 100, H)], 0);
		expect(map.watching).toBe(true);
		const c3 = map.track(subtitleFrame(4, 2), subtitleFrame(3, 2), 800, 600, 300, 24);
		expect(c3.watched).toBe(100 * H);
		// Subtitle 2 has been up for 300 ms at 1000: it arrives, on both sides of the watch line.
		const c4 = map.track(subtitleFrame(5, 2), subtitleFrame(4, 2), 1000, 800, 300, 24);
		expect(c4.arrivals).toBeGreaterThan(0);
		expect(c4.arrivalsOutside).toBeGreaterThan(0);
		map.setWatch([], 0);
		expect(map.watching).toBe(false);
	});
});

describe("ChangeDetector text focus (GLIM-114)", () => {
	const subtitles = (t: number) => {
		const video = Math.floor(t / 125);
		if (t < 3000) return subtitleFrame(video, 1);
		if (t < 3500) return subtitleFrame(video, null);
		if (t < 6500) return subtitleFrame(video, 2);
		return subtitleFrame(video, 3);
	};

	test("subtitles over a moving video: each new subtitle is read once, after it is stable", async () => {
		const { processed, detector, out } = await run(subtitles, { untilMs: 9000, areas: [SUBTITLE_BOX] });
		// First frame, then subtitle 2 (shown from 3500) and 3 (from 6500), nothing else.
		expect(processed).toHaveLength(3);
		expect(processed[0]).toBe(0);
		expect(processed[1]).toBeGreaterThanOrEqual(3500 + 300);
		expect(processed[1]).toBeLessThan(3500 + 1500);
		expect(processed[2]).toBeGreaterThanOrEqual(6500 + 300);
		expect(processed[2]).toBeLessThan(6500 + 1500);
		expect(detector.focused).toBe(true);
		expect(detector.stats().focusEntered).toBe(1);
		const settled = out.filter((o) => o.d.kind === "settled");
		for (const s of settled) expect(s.d).toMatchObject({ scope: "text" });
	});

	test("the same works before anything was read (no text boxes: the whole region is watched)", async () => {
		const { processed } = await run(subtitles, { untilMs: 9000 });
		expect(processed).toHaveLength(3);
	});

	test("without text focus the moving video never settles (the GLIM-58 behaviour)", async () => {
		const detector = new ChangeDetector({ diffThreshold: 0.02, stabilityMs: 300, textFocus: false });
		const { processed } = await run(subtitles, { untilMs: 9000, detector });
		expect(processed).toEqual([0]);
	});

	test("a typewriter in a dialogue box over a moving scene is read once, after it stops", async () => {
		// Typing starts at 2000 (focus is on by then), one character every 150 ms, 10 characters.
		const frameAt = (t: number) =>
			dialogueFrame(Math.floor(t / 125), t < 2000 ? 0 : Math.min(10, 1 + Math.floor((t - 2000) / 150)));
		const { processed } = await run(frameAt, { untilMs: 6000 });
		const typingEnds = 2000 + 9 * 150;
		expect(processed.filter((t) => t > 0 && t < typingEnds + 300)).toEqual([]);
		expect(processed.filter((t) => t >= typingEnds)).toHaveLength(1);
	});

	test("text scrolling over a moving background is never read mid-scroll", async () => {
		// Subtitle band strokes shift 2 px every 125 ms from 2000 to 4000, then hold.
		const frameAt = (t: number) => {
			const video = Math.floor(t / 125);
			const dx = t < 2000 ? 0 : Math.min(32, Math.floor((t - 2000) / 125) * 2);
			const bg = videoAt(video);
			return makeImage(W, H, (x, y) => (glyph(1)(x - dx, y) ? [255, 255, 255] : bg(x, y)));
		};
		const { processed } = await run(frameAt, { untilMs: 7000, areas: [SUBTITLE_BOX] });
		expect(processed.filter((t) => t > 0 && t < 4000 + 300)).toEqual([]);
		expect(processed.filter((t) => t >= 4000)).toHaveLength(1);
	});

	test("new still content outside the text boxes is read; a small still patch of video isn't", async () => {
		// Subtitle 1 throughout; a patch on the left freezes from 3000 (a new label, or a still bit of video).
		const withPatch = (pw: number, ph: number) => (t: number) => {
			const video = Math.floor(t / 125);
			const bg = videoAt(video);
			const fg = videoAt(t >= 3000 ? 9999 : video);
			return makeImage(W, H, (x, y) => (glyph(1)(x, y) ? [255, 255, 255] : x < pw && y < ph ? fg(x, y) : bg(x, y)));
		};
		const small = await run(withPatch(12, 12), { untilMs: 6000, areas: [SUBTITLE_BOX] });
		expect(small.processed).toEqual([0]);
		const large = await run(withPatch(36, 20), { untilMs: 6000, areas: [SUBTITLE_BOX] });
		expect(large.processed).toHaveLength(2);
		expect(large.processed[1]).toBeGreaterThanOrEqual(3300);
	});

	test("when the video stops, detection is back on the whole region (a paused frame is read once)", async () => {
		const frameAt = (t: number) => subtitleFrame(t < 4000 ? Math.floor(t / 125) : 32, 1);
		const { processed, detector } = await run(frameAt, { untilMs: 6000, areas: [SUBTITLE_BOX] });
		expect(detector.focused).toBe(false);
		expect(detector.stats().focusEntered).toBe(1);
		// The paused video differs from the first frame's video: one read once it holds still.
		expect(processed).toHaveLength(2);
		expect(processed[1]).toBeGreaterThanOrEqual(4000 + 300);
	});

	test("short motion (under backgroundMs) never enters focus", async () => {
		const frameAt = (t: number) => subtitleFrame(t >= 1000 && t < 2000 ? Math.floor(t / 125) : 0, 1);
		const { detector } = await run(frameAt, { untilMs: 4000 });
		expect(detector.stats().focusEntered).toBe(0);
	});
});
