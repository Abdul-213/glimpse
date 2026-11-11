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
//
// GLIM-114, moving backgrounds: when the whole region has been moving on every grab for
// `backgroundMs` (1.5 s: longer than a typewriter line or a scroll, shorter than any video),
// the detector switches to *text focus*: it stops measuring the whole region and watches only
// what holds still (stillness.ts): overlay text that changed, or new overlay text that has
// been up for `stabilityMs`, inside the last OCR result's text boxes (`setTextAreas`; the
// whole region before anything was read). Once that has been quiet for `stabilityMs`, the
// still pixels are compared with the processed frame and only a real difference re-runs OCR.
// Moving text is never still, so it can't trigger a read: the GLIM-58 guarantees (no OCR of
// half-typed lines, none while scrolling) hold in focus too. As soon as the region stops
// moving, the detector is back to whole-region detection; static backgrounds never enter
// focus, so their behaviour is exactly GLIM-58's.

import type { CaptureFrame } from "../capture/port.ts";
import { type Rect, rect } from "../geometry.ts";
import { type StillnessCounts, StillnessMap } from "./stillness.ts";

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
	/** GLIM-114: switch to text focus over a moving background. Default true. */
	readonly textFocus?: boolean;
	/** Whole-region motion on every grab for this long = a moving background. Default 1500. */
	readonly backgroundMs?: number;
	/** In focus: watched pixels that must move (or arrive) to count as motion. Default 0.005. */
	readonly focusMotionThreshold?: number;
	/** Text boxes are grown by this many logical px to make the watch mask. Default 16. */
	readonly textMargin?: number;
}

export const CHANGE_DETECTION_DEFAULTS = {
	diffThreshold: 0.02,
	stabilityMs: 300,
	motionThreshold: 0.002,
	tolerance: DIFF_TOLERANCE_DEFAULT,
	textFocus: true,
	backgroundMs: 1500,
	focusMotionThreshold: 0.005,
	textMargin: 16,
} as const;

/** What a decision measured: the whole region (GLIM-58) or the still text over a moving background (GLIM-114). */
export type DetectionScope = "region" | "text";

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
			/** Present (`text`) only in text focus. */
			readonly scope?: DetectionScope;
	  }
	/** Stable and different enough from the processed frame: re-run OCR. */
	| {
			readonly kind: "settled";
			readonly trigger: "stable" | "resume";
			readonly diff: FrameDiff;
			readonly stableForMs: number;
			readonly scope?: DetectionScope;
	  }
	/** Stable, but within `diffThreshold` of the processed frame (caret blink, flicker that came back). */
	| { readonly kind: "below-threshold"; readonly diff: FrameDiff; readonly scope?: DetectionScope };

export const shouldProcess = (d: ChangeDecision): boolean => d.kind === "first" || d.kind === "settled";

export interface ChangeDetectorStats {
	readonly frames: number;
	/** Pixel diffs computed (motion + baseline). Same-sequence frames need none. */
	readonly diffs: number;
	readonly diffMs: number;
	readonly settled: number;
	readonly belowThreshold: number;
	/** Grabs decided in text focus (GLIM-114), and how often focus was entered. */
	readonly focusedGrabs: number;
	readonly focusEntered: number;
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
	#map: StillnessMap | null = null;
	#areas: readonly Rect[] = [];
	/** Since when every new grab has been moving (whole region), or null. */
	#movingSince: number | null = null;
	#focused = false;
	#focusedGrabs = 0;
	#focusEntered = 0;
	#lastAt: number | null = null;
	/** Text focus: the pending change includes new still content outside the text boxes. */
	#elsewhere = false;
	/** GLIM-66: no settle before this time (the CPU budget's gap between OCR runs). */
	#holdUntil = 0;

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
		this.#map = null;
		this.#areas = [];
		this.#leaveFocus();
	}

	/**
	 * GLIM-66: don't call anything settled before `t` (frame time). A change that settles
	 * earlier waits (`settling`, reason `waiting`, woken at `t`) and is compared then.
	 */
	holdUntil(t: number): void {
		this.#holdUntil = t;
	}

	/** True while deciding in text focus (a moving background, GLIM-114). */
	get focused(): boolean {
		return this.#focused;
	}

	/**
	 * GLIM-114: the text boxes of the last OCR result (region-local device px, the frame's
	 * space). Text focus watches them; an empty list watches the whole region.
	 */
	setTextAreas(areas: readonly Rect[]): void {
		this.#areas = areas.map((a) => ({ ...a }));
		this.#map?.setWatch(this.#areas, this.#o.textMargin * this.#map.stride);
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
			focusedGrabs: this.#focusedGrabs,
			focusEntered: this.#focusEntered,
		};
	}

	feed(frame: Frame): ChangeDecision {
		this.#frames++;
		const now = frame.capturedAt;
		// The previous grab's time (a same-sequence frame keeps its original capturedAt).
		const previousAt = this.#lastAt ?? now;
		this.#lastAt = now;
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
			// What was still before the pause says nothing about now.
			this.#leaveFocus();
			this.#mapFor(frame).restart(now);
			return this.#compare(frame, baseline, 0, "resume");
		}
		// Same backend sequence within a session = identical pixels (CaptureFrame contract).
		const sameSequence =
			frame.sequence === previous.sequence && frame.width === previous.width && frame.height === previous.height;
		let motion: FrameDiff | null = null;
		// No new content from the backend for a stability window: whatever was moving stopped.
		// (A grab soon after the last one can see the same video frame; that says nothing.)
		if (sameSequence && now - previous.capturedAt >= this.#o.stabilityMs) {
			if (this.#focused) {
				// Back to the whole region, as if the region had just come to rest.
				this.#leaveFocus();
				this.#pending = true;
				this.#stableSince = previous.capturedAt;
			}
			this.#movingSince = null;
		}
		if (sameSequence && this.#focused) {
			// A quick re-grab (wake hint) that saw the same video frame: nothing new to count.
			const none = { fraction: 0, sampled: frame.width * frame.height, box: null };
			const zero = { motion: none, watched: 1, stillChanged: 0, arrivals: 0, arrivalsOutside: 0 };
			return this.#feedFocused(frame, baseline, zero, now);
		}
		if (!sameSequence) {
			const counts = this.#track(frame, previous, previousAt);
			motion = counts.motion;
			this.#previous = frame;
			const moving = motion.fraction >= this.#o.motionThreshold;
			if (moving) {
				this.#movingSince ??= now;
				if (!this.#focused && this.#o.textFocus && now - this.#movingSince >= this.#o.backgroundMs) {
					this.#focused = true;
					this.#focusEntered++;
					this.#pending = true;
					this.#stableSince = now;
				}
			} else if (this.#focused) {
				this.#leaveFocus();
				this.#pending = true;
				this.#stableSince = previousAt;
			} else {
				this.#movingSince = null;
			}
			if (this.#focused) return this.#feedFocused(frame, baseline, counts, now);
			if (moving) {
				this.#stableSince = now;
				this.#pending = true;
				return { kind: "settling", reason: "moving", stableForMs: 0, wakeInMs: this.#o.stabilityMs, motion };
			}
			// A small change (caret blink) doesn't hold the region back, but it may add up.
			if (motion.box) this.#pending = true;
		}
		if (!this.#pending) return { kind: "same" };
		const stableForMs = now - this.#stableSince;
		const wait = Math.max(this.#o.stabilityMs - stableForMs, this.#holdUntil - now);
		if (wait > 0) {
			return { kind: "settling", reason: "waiting", stableForMs, wakeInMs: wait, motion };
		}
		this.#pending = false;
		return this.#compare(frame, baseline, stableForMs, "stable");
	}

	/** One grab in text focus (GLIM-114). */
	#feedFocused(frame: Frame, baseline: Frame, c: StillnessCounts, now: number): ChangeDecision {
		this.#focusedGrabs++;
		const o = this.#o;
		const textMotion = (c.stillChanged + c.arrivals) / Math.max(1, c.watched);
		const elsewhere = c.arrivalsOutside / Math.max(1, c.motion.sampled);
		if (textMotion >= o.focusMotionThreshold || elsewhere >= o.diffThreshold) {
			this.#stableSince = now;
			this.#pending = true;
			if (elsewhere >= o.diffThreshold) this.#elsewhere = true;
			return {
				kind: "settling",
				reason: "moving",
				stableForMs: 0,
				wakeInMs: o.stabilityMs,
				motion: c.motion,
				scope: "text",
			};
		}
		if (!this.#pending) return { kind: "same" };
		const stableForMs = now - this.#stableSince;
		const wait = Math.max(o.stabilityMs - stableForMs, this.#holdUntil - now);
		if (wait > 0) {
			return { kind: "settling", reason: "waiting", stableForMs, wakeInMs: wait, motion: c.motion, scope: "text" };
		}
		this.#pending = false;
		const t0 = this.#perf();
		const d = this.#mapFor(frame).compareStill(frame, baseline, now, 2 * o.stabilityMs, o.tolerance);
		this.#diffMs += this.#perf() - t0;
		this.#diffs++;
		// With text boxes, judge by them: a patch of video that happens to hold still elsewhere
		// isn't text. New text that appeared outside them (`elsewhere`) is judged on the region.
		const fraction = this.#watching() && !this.#elsewhere ? d.watchedFraction : d.fraction;
		this.#elsewhere = false;
		const diff: FrameDiff = { fraction, sampled: d.sampled, box: d.box };
		if (fraction >= o.diffThreshold && d.box) {
			this.#take(frame);
			this.#settled++;
			return { kind: "settled", trigger: "stable", diff, stableForMs, scope: "text" };
		}
		this.#below++;
		return { kind: "below-threshold", diff, scope: "text" };
	}

	#leaveFocus(): void {
		this.#focused = false;
		this.#movingSince = null;
		this.#elsewhere = false;
	}

	#watching(): boolean {
		return this.#map?.watching ?? false;
	}

	/** The stillness map for this frame size (a new one when the size or scale changed). */
	#mapFor(frame: Frame): StillnessMap {
		const stride = Math.max(1, Math.floor(frame.scale));
		let map = this.#map;
		if (!map || map.width !== frame.width || map.height !== frame.height || map.stride !== stride) {
			map = new StillnessMap(frame.width, frame.height, stride, frame.capturedAt);
			map.setWatch(this.#areas, this.#o.textMargin * stride);
			this.#map = map;
		}
		return map;
	}

	/** The motion diff against the previous grab, recording per-pixel stillness on the way. */
	#track(frame: Frame, previous: Frame, previousAt: number): StillnessCounts {
		const t0 = this.#perf();
		let counts: StillnessCounts;
		if (frame.width !== previous.width || frame.height !== previous.height) {
			this.#map = null;
			this.#mapFor(frame);
			counts = { motion: diffFrames(frame, previous), watched: 1, stillChanged: 0, arrivals: 0, arrivalsOutside: 0 };
		} else {
			counts = this.#mapFor(frame).track(
				frame,
				previous,
				frame.capturedAt,
				previousAt,
				this.#o.stabilityMs,
				this.#o.tolerance,
			);
		}
		this.#diffMs += this.#perf() - t0;
		this.#diffs++;
		return counts;
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
		this.#mapFor(frame);
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
