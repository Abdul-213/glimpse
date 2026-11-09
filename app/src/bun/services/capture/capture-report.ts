// GLIM-156: one log line per Snip capture, so a "Glimpse couldn't capture this area" report
// from the owner's diagnostics says why. The popup shows the same copy for an all-black frame
// (captureBlank) and a capture that threw (captureFailed); the line tells them apart and carries
// what decides the cause: the backend, the plan (rect, output size, scale, displays, partial),
// how much of the frame is black, and the caller's context (picker overlay states with their
// read-back capture affinity, registered window ids, mask rects).
//
//   info  "snip capture"                    every Snip
//   warn  "snip capture came back black"    every pixel black (the pipeline's isBlankImage)
//   warn  "snip capture failed"             the backend threw
import type { CaptureFrame, CaptureOptions, CaptureSource, Logger, Rect } from "@glimpse/core";
import { isCaptureError } from "@glimpse/core";

/** Same threshold as the pipeline's isBlankImage: a channel above 2 is not black. */
const BLACK_MAX = 2;

/** Fraction of pixels (RGBA8) whose red, green and blue are all at most 2. 1 for an empty frame. */
export function blackRatio(data: Uint8Array): number {
	const pixels = Math.floor(data.length / 4);
	if (pixels === 0) return 1;
	let black = 0;
	for (let i = 0; i + 3 < data.length; i += 4) {
		if ((data[i] ?? 0) <= BLACK_MAX && (data[i + 1] ?? 0) <= BLACK_MAX && (data[i + 2] ?? 0) <= BLACK_MAX) black++;
	}
	return black / pixels;
}

export interface CaptureReportOptions {
	readonly log: Logger;
	/** Extra fields read at capture time (overlay states, exclusion). Must not throw; errors are logged as such. */
	readonly context?: () => Record<string, unknown>;
	readonly now?: () => number;
}

const rectText = (r: Rect) => `${r.x},${r.y} ${r.width}x${r.height}`;

/**
 * `source` for Snip, with the GLIM-156 log line. Frames and errors pass through untouched; the
 * report adds one pass over the pixels.
 */
export function reportingCapture(source: CaptureSource, o: CaptureReportOptions): Pick<CaptureSource, "capture"> {
	const now = o.now ?? Date.now;
	const context = (): Record<string, unknown> => {
		try {
			return o.context?.() ?? {};
		} catch (error) {
			return { contextError: error instanceof Error ? error.message : String(error) };
		}
	};
	const displays = () => {
		try {
			return source.displays().map((d) => `${d.id}:${rectText(d.bounds)}@${d.scaleFactor}`);
		} catch {
			return [];
		}
	};
	return {
		async capture(rect: Rect, options?: CaptureOptions): Promise<CaptureFrame> {
			const started = now();
			let frame: CaptureFrame;
			try {
				frame = await source.capture(rect, options);
			} catch (error) {
				o.log.warn("snip capture failed", {
					backend: source.backend,
					rect: rectText(rect),
					code: isCaptureError(error) ? error.code : null,
					error,
					ms: now() - started,
					displays: displays(),
					...context(),
				});
				throw error;
			}
			const ratio = blackRatio(frame.data);
			const fields = {
				backend: source.backend,
				rect: rectText(rect),
				size: `${frame.width}x${frame.height}`,
				scale: frame.scale,
				displayIds: frame.displayIds,
				partial: frame.partial,
				blackRatio: Math.round(ratio * 10_000) / 10_000,
				ms: now() - started,
			};
			if (ratio >= 1) {
				o.log.warn("snip capture came back black", { ...fields, displays: displays(), ...context() });
			} else {
				o.log.info("snip capture", { ...fields, ...context() });
			}
			return frame;
		},
	};
}
