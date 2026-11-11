// Fake CaptureSource for tests in any package: replays in-memory frames over a fake
// display layout. Use solidImage / makeImage to build frames without PNG files.
import { type FrameSequenceOptions, FrameSequenceSource, type SequenceFrame } from "../capture/frame-sequence.ts";
import { allocRgba, type RgbaImage } from "../capture/pixels.ts";
import type { CaptureDisplay } from "../capture/plan.ts";
import { rect } from "../geometry.ts";

export type ReplayOptions = Omit<FrameSequenceOptions, "displays" | "frames" | "now"> & {
	readonly displays?: readonly CaptureDisplay[];
	readonly now?: () => number;
};

/**
 * A CaptureSource that replays `frames` (whole-desktop images). Defaults: one display
 * the size of the first frame at scale 1, `per-grab` advance, holding the last frame,
 * and a clock stuck at 0 (pass `new ManualClock().now` to drive `timed` mode).
 */
export class ReplayCaptureSource extends FrameSequenceSource {
	constructor(frames: readonly (RgbaImage | SequenceFrame)[], options: ReplayOptions = {}) {
		const seq: SequenceFrame[] = frames.map((f) => ("image" in f ? f : { image: f }));
		const first = seq[0]?.image;
		const displays = options.displays ?? (first ? [singleDisplay(first.width, first.height)] : []);
		super({ ...options, displays, frames: seq, now: options.now ?? (() => 0), backend: options.backend ?? "replay" });
	}
}

/** One primary display covering a `width` x `height` px image at `scale` px per logical unit. */
export function singleDisplay(width: number, height: number, scale = 1, id = 1): CaptureDisplay {
	const bounds = rect(0, 0, width / scale, height / scale);
	return { id, bounds, workArea: bounds, scaleFactor: scale, isPrimary: true, nativeBounds: rect(0, 0, width, height) };
}

/** A manual clock: `now()` returns what `advance` / `set` made it. */
export class ManualClock {
	constructor(private t = 0) {}
	readonly now = (): number => this.t;
	advance(ms: number): void {
		this.t += ms;
	}
	set(ms: number): void {
		this.t = ms;
	}
}

/** An image filled with one colour. */
export function solidImage(width: number, height: number, [r, g, b]: readonly [number, number, number]): RgbaImage {
	return makeImage(width, height, () => [r, g, b]);
}

/** An image whose pixel (x, y) is `paint(x, y)`. */
export function makeImage(
	width: number,
	height: number,
	paint: (x: number, y: number) => readonly [number, number, number],
): RgbaImage {
	const img = allocRgba(width, height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b] = paint(x, y);
			const i = (y * width + x) * 4;
			img.data[i] = r;
			img.data[i + 1] = g;
			img.data[i + 2] = b;
			img.data[i + 3] = 255;
		}
	}
	return img;
}

/** RGB of pixel (x, y); -1 channels when out of range. */
export function pixelAt(img: { readonly width: number; readonly data: Uint8Array }, x: number, y: number): number[] {
	const i = (y * img.width + x) * 4;
	return [img.data[i] ?? -1, img.data[i + 1] ?? -1, img.data[i + 2] ?? -1];
}
