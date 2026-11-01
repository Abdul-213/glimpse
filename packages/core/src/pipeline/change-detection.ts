// GLIM-58: Live change detection. Re-run OCR only when the region's pixels differ from what
// was last processed by more than a threshold AND the region has been stable for ~300 ms
// (PRODUCT.md Live flow; live-popup.md §8 "Settle"). Pure: frames in, decisions out; time is
// each frame's `capturedAt`.
//
// Two thresholds, on purpose:
// - `motionThreshold` (small, 0.2 % of sampled pixels by default) decides "still moving". It
//   is low so a typewriter effect, a fade or a scroll keeps the region unsettled until it
//   stops: no OCR of half-written lines (acceptance: no re-OCR while animating or scrolling).
//   Changes below it (a blinking caret) don't hold the region back.
// - `diffThreshold` (Settings › Live, 2 % by default) decides "worth re-reading": once stable,
//   the frame is compared with the last processed one, and only a bigger difference re-runs
//   OCR. A caret blink, or content that flickered and came back, doesn't.
//
// Frames whose backend `sequence` didn't move are identical by contract (DXGI / SCStream
// report no new content), so they cost no diff at all.

import type { CaptureFrame } from "../capture/port.ts";
import { type Rect, rect } from "../geometry.ts";

export interface DiffOptions {
	/** A pixel counts as changed when any RGB channel moves by more than this (0-255). */
	readonly tolerance?: number;
	/** Sample every `stride`-th pixel in both directions (1 = every pixel). */
	readonly stride?: number;
}

export interface FrameDiff {
	/** Changed sampled pixels / sampled pixels, 0..1. Different sizes count as 1. */
	readonly fraction: number;
	/** Pixels sampled. */
	readonly sampled: number;
	/** Bounding box of the changed pixels in image px, or null when nothing changed. */
	readonly box: Rect | null;
}

export const DIFF_TOLERANCE_DEFAULT = 24;

/** Compare two RGBA8 images pixel by pixel (alpha ignored). */
export function diffFrames(
	a: { readonly width: number; readonly height: number; readonly data: Uint8Array },
	b: { readonly width: number; readonly height: number; readonly data: Uint8Array },
	options: DiffOptions = {},
): FrameDiff {
	const { width, height } = a;
	if (width !== b.width || height !== b.height) {
		return { fraction: 1, sampled: 0, box: rect(0, 0, Math.max(width, b.width), Math.max(height, b.height)) };
	}
	const tol = options.tolerance ?? DIFF_TOLERANCE_DEFAULT;
	const step = Math.max(1, Math.floor(options.stride ?? 1));
	const x0 = a.data;
	const x1 = b.data;
	let sampled = 0;
	let changed = 0;
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y += step) {
		let i = y * width * 4;
		const rowStep = step * 4;
		for (let x = 0; x < width; x += step, i += rowStep) {
			sampled++;
			const dr = (x0[i] ?? 0) - (x1[i] ?? 0);
			const dg = (x0[i + 1] ?? 0) - (x1[i + 1] ?? 0);
			const db = (x0[i + 2] ?? 0) - (x1[i + 2] ?? 0);
			if (dr > tol || dr < -tol || dg > tol || dg < -tol || db > tol || db < -tol) {
				changed++;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	const box =
		changed === 0 ? null : rect(minX, minY, Math.min(width, maxX + step) - minX, Math.min(height, maxY + step) - minY);
	return { fraction: sampled === 0 ? 0 : changed / sampled, sampled, box };
}

export interface ChangeDetectionOptions {
	/** Settings › Live `diffThreshold`: fraction of pixels that must differ from the processed frame. */
	readonly diffThreshold: number;
	/** Settings › Live `stabilityMs`: no motion for this long before re-OCR. */
	readonly stabilityMs: number;
	/** Fraction of pixels changing between two grabs that counts as motion. Default 0.002. */
	readonly motionThreshold?: number;
	readonly tolerance?: number;
}

export const CHANGE_DETECTION_DEFAULTS = {
	diffThreshold: 0.02,
	stabilityMs: 300,
	motionThreshold: 0.002,
	tolerance: DIFF_TOLERANCE_DEFAULT,
} as const;

/**
 * What to do with a frame. `first` and `settled` mean "process this frame" (and the detector
 * now treats it as the processed baseline); everything else means "don't".
 */
export type ChangeDecision =
	/** The first frame of the session, or after `reset()`: process at once (live-popup.md L0). */
	| { readonly kind: "first" }
	/** Nothing changed since the previous grab, and nothing is waiting to settle. */
	| { readonly kind: "same" }
	/** Pixels moved (`moving`) or haven't been still for `stabilityMs` yet (`waiting`). */
	| {
			readonly kind: "settling";
			readonly reason: "moving" | "waiting";
			readonly stableForMs: number;
			/** When the region will have been still long enough, if nothing moves (a wake hint for the loop). */
			readonly wakeInMs: number;
			readonly motion: FrameDiff | null;
	  }
	/** Stable and different enough from the processed frame: re-run OCR. */
	| {
			readonly kind: "settled";
			readonly trigger: "stable" | "resume";
			readonly diff: FrameDiff;
			readonly stableForMs: number;
	  }
	/** Stable, but within `diffThreshold` of the processed frame (caret blink, flicker that came back). */
	| { readonly kind: "below-threshold"; readonly diff: FrameDiff };

export const shouldProcess = (d: ChangeDecision): boolean => d.kind === "first" || d.kind === "settled";

export interface ChangeDetectorStats {
	readonly frames: number;
	/** Pixel diffs computed (motion + baseline). Same-sequence frames need none. */
	readonly diffs: number;
	readonly diffMs: number;
	readonly settled: number;
	readonly belowThreshold: number;
}

type Frame = Pick<CaptureFrame, "width" | "height" | "data" | "sequence" | "capturedAt" | "scale">;

export class ChangeDetector {
	#o: Required<ChangeDetectionOptions>;
	readonly #perf: () => number;
	#baseline: Frame | null = null;
	#previous: Frame | null = null;
	#stableSince = 0;
	#pending = false;
	#resume = false;
	#frames = 0;
	#diffs = 0;
	#diffMs = 0;
	#settled = 0;
	#below = 0;

	constructor(options: ChangeDetectionOptions, perfNow: () => number = () => 0) {
		this.#o = { ...CHANGE_DETECTION_DEFAULTS, ...options };
		this.#perf = perfNow;
	}

	get options(): Readonly<Required<ChangeDetectionOptions>> {
		return this.#o;
	}

	/** Runtime settings update. Applies from the next frame. */
	setOptions(options: Partial<ChangeDetectionOptions>): void {
		this.#o = { ...this.#o, ...options };
	}

	/** Forget everything: the next frame is `first` (re-pin, target or subset change). */
	reset(): void {
		this.#baseline = null;
		this.#previous = null;
		this.#pending = false;
		this.#resume = false;
	}

	/**
	 * After a pause (or a capture outage): compare the next frame with the processed one at
	 * once, without waiting for stability, so what changed while paused shows as one change
	 * set (live-popup.md L6).
	 */
	resume(): void {
		if (this.#baseline) this.#resume = true;
	}

	stats(): ChangeDetectorStats {
		return {
			frames: this.#frames,
			diffs: this.#diffs,
			diffMs: this.#diffMs,
			settled: this.#settled,
			belowThreshold: this.#below,
		};
	}

	feed(frame: Frame): ChangeDecision {
		this.#frames++;
		const now = frame.capturedAt;
		const baseline = this.#baseline;
		const previous = this.#previous;
		if (!baseline || !previous) {
			this.#take(frame);
			return { kind: "first" };
		}
		if (this.#resume) {
			this.#resume = false;
			this.#previous = frame;
			this.#stableSince = now;
			this.#pending = false;
			return this.#compare(frame, baseline, 0, "resume");
		}
		// Same backend sequence within a session = identical pixels (CaptureFrame contract).
		const sameSequence =
			frame.sequence === previous.sequence && frame.width === previous.width && frame.height === previous.height;
		let motion: FrameDiff | null = null;
		if (!sameSequence) {
			motion = this.#diff(frame, previous);
			this.#previous = frame;
			if (motion.fraction >= this.#o.motionThreshold) {
				this.#stableSince = now;
				this.#pending = true;
				return { kind: "settling", reason: "moving", stableForMs: 0, wakeInMs: this.#o.stabilityMs, motion };
			}
			// A small change (caret blink) doesn't hold the region back, but it may add up.
			if (motion.box) this.#pending = true;
		}
		if (!this.#pending) return { kind: "same" };
		const stableForMs = now - this.#stableSince;
		if (stableForMs < this.#o.stabilityMs) {
			return {
				kind: "settling",
				reason: "waiting",
				stableForMs,
				wakeInMs: this.#o.stabilityMs - stableForMs,
				motion,
			};
		}
		this.#pending = false;
		return this.#compare(frame, baseline, stableForMs, "stable");
	}

	#compare(frame: Frame, baseline: Frame, stableForMs: number, trigger: "stable" | "resume"): ChangeDecision {
		const diff = this.#diff(frame, baseline);
		if (diff.fraction >= this.#o.diffThreshold && diff.box) {
			this.#take(frame);
			this.#settled++;
			return { kind: "settled", trigger, diff, stableForMs };
		}
		this.#below++;
		return { kind: "below-threshold", diff };
	}

	#take(frame: Frame): void {
		this.#baseline = frame;
		this.#previous = frame;
		this.#stableSince = frame.capturedAt;
		this.#pending = false;
	}

	#diff(a: Frame, b: Frame): FrameDiff {
		const t0 = this.#perf();
		// Sample once per logical pixel: at 2x every other device pixel in each direction, which
		// still sees every glyph stroke (≥ 1 logical px wide) at a quarter of the cost.
		const d = diffFrames(a, b, { tolerance: this.#o.tolerance, stride: Math.max(1, Math.floor(a.scale)) });
		this.#diffMs += this.#perf() - t0;
		this.#diffs++;
		return d;
	}
}
