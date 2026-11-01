// GLIM-114: per-pixel stillness for Live change detection over a moving background.
//
// GLIM-58 measures motion over the whole region, so a region whose background keeps moving
// (burned-in subtitles over playing video, a dialogue box over an animated game scene) never
// settles. What tells text apart there is time: overlay text holds still for as long as it is
// shown, the video behind it doesn't. `StillnessMap` remembers, for every sampled pixel, when
// it last changed. From that:
//
// - a *still* pixel has not changed for `stillMs` (the stability window): overlay text, UI
//   chrome, letterbox bars. This is the text-likeness mask: video pixels are never in it.
// - a still pixel that changes means something that was holding still moved: a subtitle was
//   replaced, a typewriter drew over a still background, text scrolled.
// - an *arrival* is a pixel that just became still: new overlay text has been up for `stillMs`.
//
// Counts are taken inside a watch mask (the last OCR result's text boxes, grown by a margin;
// the whole region when nothing has been read yet) so a still patch of video somewhere else
// can't hold Live back. Arrivals outside it are counted separately: enough of them means new
// text appeared somewhere else.
//
// One pass per grab does the GLIM-58 motion diff too, with the same sampling and tolerance as
// `diffFrames`, so the whole-region numbers are exactly the ones GLIM-58 used.

import { type Rect, rect } from "../geometry.ts";
import type { FrameDiff } from "./change-detection.ts";

interface Pixels {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8Array;
}

export interface StillnessCounts {
	/** The GLIM-58 motion diff against the previous grab (whole region). */
	readonly motion: FrameDiff;
	/** Watched samples (the whole grid when there is no watch mask). */
	readonly watched: number;
	/** Watched samples that were still at the previous grab and changed now. */
	readonly stillChanged: number;
	/** Watched samples that became still on this grab. */
	readonly arrivals: number;
	/** Unwatched samples that became still on this grab. */
	readonly arrivalsOutside: number;
}

export interface StillDiff extends FrameDiff {
	/** Still samples compared. */
	readonly still: number;
	/** Of the differing still samples, how many are watched, over `watched`. 0 without a mask. */
	readonly watchedFraction: number;
}

export class StillnessMap {
	readonly width: number;
	readonly height: number;
	readonly stride: number;
	readonly #gw: number;
	readonly #gh: number;
	/** Time each sample last changed (frame `capturedAt`). */
	readonly #last: Float64Array;
	/** 1 = inside a text area. Null = watch everything. */
	#watch: Uint8Array | null = null;
	#watchedCount: number;

	constructor(width: number, height: number, stride: number, now: number) {
		this.width = width;
		this.height = height;
		this.stride = Math.max(1, Math.floor(stride));
		this.#gw = Math.ceil(width / this.stride);
		this.#gh = Math.ceil(height / this.stride);
		this.#last = new Float64Array(this.#gw * this.#gh).fill(now);
		this.#watchedCount = this.#gw * this.#gh;
	}

	get samples(): number {
		return this.#gw * this.#gh;
	}

	get watching(): boolean {
		return this.#watch !== null;
	}

	/** Everything counts as just changed (after a pause: the history is stale). */
	restart(now: number): void {
		this.#last.fill(now);
	}

	/**
	 * Watch only these areas (region-local device px), each grown by `margin` px. An empty
	 * list watches the whole region (nothing read yet, or the last read found no text).
	 */
	setWatch(areas: readonly Rect[], margin: number): void {
		if (areas.length === 0) {
			this.#watch = null;
			this.#watchedCount = this.samples;
			return;
		}
		const w = new Uint8Array(this.samples);
		const s = this.stride;
		for (const a of areas) {
			const x0 = Math.max(0, Math.floor((a.x - margin) / s));
			const y0 = Math.max(0, Math.floor((a.y - margin) / s));
			const x1 = Math.min(this.#gw, Math.ceil((a.x + a.width + margin) / s));
			const y1 = Math.min(this.#gh, Math.ceil((a.y + a.height + margin) / s));
			for (let gy = y0; gy < y1; gy++) w.fill(1, gy * this.#gw + x0, gy * this.#gw + Math.max(x0, x1));
		}
		let n = 0;
		for (const v of w) n += v;
		this.#watch = n > 0 ? w : null;
		this.#watchedCount = n > 0 ? n : this.samples;
	}

	/**
	 * One grab: `frame` (at `now`) against the previous grab (at `previousAt`). Updates every
	 * sample's last-change time and returns the motion diff and the stillness counts.
	 */
	track(
		frame: Pixels,
		previous: Pixels,
		now: number,
		previousAt: number,
		stillMs: number,
		tolerance: number,
	): StillnessCounts {
		const { width, height } = this;
		const step = this.stride;
		const a = frame.data;
		const b = previous.data;
		const last = this.#last;
		const watch = this.#watch;
		let sampled = 0;
		let changed = 0;
		let stillChanged = 0;
		let arrivals = 0;
		let arrivalsOutside = 0;
		let minX = width;
		let minY = height;
		let maxX = -1;
		let maxY = -1;
		let g = 0;
		for (let y = 0; y < height; y += step) {
			let i = y * width * 4;
			const rowStep = step * 4;
			for (let x = 0; x < width; x += step, i += rowStep, g++) {
				sampled++;
				const dr = (a[i] ?? 0) - (b[i] ?? 0);
				const dg = (a[i + 1] ?? 0) - (b[i + 1] ?? 0);
				const db = (a[i + 2] ?? 0) - (b[i + 2] ?? 0);
				const t = last[g] as number;
				const watched = watch === null || watch[g] === 1;
				if (
					dr > tolerance ||
					dr < -tolerance ||
					dg > tolerance ||
					dg < -tolerance ||
					db > tolerance ||
					db < -tolerance
				) {
					changed++;
					if (x < minX) minX = x;
					if (x > maxX) maxX = x;
					if (y < minY) minY = y;
					if (y > maxY) maxY = y;
					if (watched && previousAt - t >= stillMs) stillChanged++;
					last[g] = now;
				} else if (now - t >= stillMs && previousAt - t < stillMs) {
					if (watched) arrivals++;
					else arrivalsOutside++;
				}
			}
		}
		const box =
			changed === 0
				? null
				: rect(minX, minY, Math.min(width, maxX + step) - minX, Math.min(height, maxY + step) - minY);
		return {
			motion: { fraction: sampled === 0 ? 0 : changed / sampled, sampled, box },
			watched: this.#watchedCount,
			stillChanged,
			arrivals,
			arrivalsOutside,
		};
	}

	/**
	 * Compare `frame` with `baseline` over the samples that are still at `now`: what overlay
	 * text differs from the processed frame, ignoring whatever the background is doing.
	 * `fraction` is over all samples (like the GLIM-58 baseline diff).
	 */
	compareStill(frame: Pixels, baseline: Pixels, now: number, stillMs: number, tolerance: number): StillDiff {
		const { width, height } = this;
		const step = this.stride;
		const a = frame.data;
		const b = baseline.data;
		const last = this.#last;
		const watch = this.#watch;
		let sampled = 0;
		let still = 0;
		let differ = 0;
		let differWatched = 0;
		let minX = width;
		let minY = height;
		let maxX = -1;
		let maxY = -1;
		let g = 0;
		for (let y = 0; y < height; y += step) {
			let i = y * width * 4;
			const rowStep = step * 4;
			for (let x = 0; x < width; x += step, i += rowStep, g++) {
				sampled++;
				if (now - (last[g] as number) < stillMs) continue;
				still++;
				const dr = (a[i] ?? 0) - (b[i] ?? 0);
				const dg = (a[i + 1] ?? 0) - (b[i + 1] ?? 0);
				const db = (a[i + 2] ?? 0) - (b[i + 2] ?? 0);
				if (
					dr > tolerance ||
					dr < -tolerance ||
					dg > tolerance ||
					dg < -tolerance ||
					db > tolerance ||
					db < -tolerance
				) {
					differ++;
					if (watch !== null && watch[g] === 1) differWatched++;
					if (x < minX) minX = x;
					if (x > maxX) maxX = x;
					if (y < minY) minY = y;
					if (y > maxY) maxY = y;
				}
			}
		}
		const box =
			differ === 0 ? null : rect(minX, minY, Math.min(width, maxX + step) - minX, Math.min(height, maxY + step) - minY);
		return {
			fraction: sampled === 0 ? 0 : differ / sampled,
			sampled,
			box,
			still,
			watchedFraction: watch === null ? 0 : differWatched / Math.max(1, this.#watchedCount),
		};
	}
}
