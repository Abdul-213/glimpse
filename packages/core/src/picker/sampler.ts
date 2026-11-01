// Loupe pixels from a capture frame (region-picker spec 2 C, 4.2, 8). Pure over the
// CaptureSource port: Windows (GDI one-shots of a 15 x 15 px rect are ~1 ms), the
// file-based Linux backend and tests use this. macOS keeps a ScreenCaptureKit stream
// warm instead (app/src/bun/services/picker/mac-sampler.ts).
import type { CaptureSource } from "../capture/port.ts";
import type { Point, Rect } from "../geometry.ts";
import type { Display } from "../region.ts";
import { displayAt } from "./geometry.ts";
import type { LoupePatch, PixelSampler } from "./ports.ts";

/** Default loupe size: 15 x 15 device px (spec 2 C). */
export const LOUPE_CELLS = 15;

/** The device pixel under a global logical point, on its display (display-local px). */
export function devicePixelAt(display: Display, p: Point): Point {
	const s = display.scaleFactor > 0 ? display.scaleFactor : 1;
	return { x: Math.floor((p.x - display.bounds.x) * s), y: Math.floor((p.y - display.bounds.y) * s) };
}

/**
 * The global logical rect covering `size` x `size` device px of `display`, centred on
 * the device pixel under `p`. On a 2x display a 15-cell loupe covers 7.5 x 7.5 logical px.
 */
export function loupeRect(display: Display, p: Point, size = LOUPE_CELLS): Rect {
	const s = display.scaleFactor > 0 ? display.scaleFactor : 1;
	const c = devicePixelAt(display, p);
	const half = Math.floor(size / 2);
	return {
		x: display.bounds.x + (c.x - half) / s,
		y: display.bounds.y + (c.y - half) / s,
		width: size / s,
		height: size / s,
	};
}

/**
 * A PixelSampler that does one small one-shot capture per sample. Capture failures
 * resolve null (the loupe shows its empty grid); they are reported once through `onError`.
 */
export class CapturePixelSampler implements PixelSampler {
	private reported = false;

	constructor(
		private readonly source: CaptureSource,
		private readonly onError: (error: unknown) => void = () => {},
	) {}

	async sample(centre: Point, size = LOUPE_CELLS): Promise<LoupePatch | null> {
		const display = displayAt(this.source.displays(), centre);
		if (!display) return null;
		const rect = loupeRect(display, centre, size);
		try {
			const frame = await this.source.capture(rect, { scale: display.scaleFactor > 0 ? display.scaleFactor : 1 });
			if (frame.width !== size || frame.height !== size) return null;
			return { centre, displayId: display.id, size, rgba: frame.data, sequence: frame.sequence };
		} catch (error) {
			if (!this.reported) {
				this.reported = true;
				this.onError(error);
			}
			return null;
		}
	}

	stop(): void {
		this.reported = false;
	}
}
