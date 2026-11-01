// Pure capture geometry: split a global logical rect into per-display pieces and say
// where each piece comes from (in the backend's native space) and where it lands in
// the output buffer. Ported from spikes/capture/src/core/geometry.ts (planCapture +
// logicalToNative), generalised so one function serves every backend.
//
// Spaces (see geometry.ts for logical vs physical):
//   logical  - Electrobun's Screen space. macOS: global points. Windows: Electrobun's
//              synthesised DIP layout (each monitor at physical / scale, placed next to
//              its neighbour), which is NOT a uniform scaling of the physical desktop.
//   native   - what the backend addresses. macOS: global points again (ScreenCaptureKit
//              takes a display-local source rect in points and an output size in px).
//              Windows: global physical virtual-desktop px (GDI, DXGI, PMv2-aware).
//              File backend: px of the frame image.
import { intersection, type Rect } from "../geometry.ts";
import type { Display } from "../region.ts";

/** A display with both its logical bounds and its bounds in the backend's native space. */
export interface CaptureDisplay extends Display {
	/** Bounds in the backend's native space (see the header). */
	readonly nativeBounds: Rect;
}

export interface CapturePiece {
	readonly displayId: number;
	/** Part of the requested rect on this display, global logical. */
	readonly logical: Rect;
	/** The same part in global native units. Integer edges when `snapSource` was set. */
	readonly source: Rect;
	/** `source` relative to the display's native origin (DXGI / SCK want display-local). */
	readonly sourceLocal: Rect;
	/** Where it lands in the output buffer, integer px. Pieces tile without gaps. */
	readonly dest: Rect;
}

export interface CapturePlan {
	/** The requested global logical rect. */
	readonly rect: Rect;
	/** Output px per logical unit. */
	readonly scale: number;
	readonly width: number;
	readonly height: number;
	readonly pieces: readonly CapturePiece[];
	/** Part of the rect is on no display (left opaque black). */
	readonly partial: boolean;
}

export interface PlanOptions {
	/** Output px per logical unit. Default: the highest scaleFactor among displays the rect touches. */
	readonly scale?: number;
	/**
	 * Round source edges to whole native units. Set it for pixel-addressed backends
	 * (Windows, file); leave it off for ScreenCaptureKit, which takes fractional points.
	 */
	readonly snapSource?: boolean;
}

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;

/**
 * Plan a capture of `rect` (global logical) across `displays`.
 *
 * - Output scale: highest `scaleFactor` touched, so a rect spanning a 2x and a 1x display
 *   keeps full detail on the 2x part and upsamples the 1x part. OCR wants the detail; a
 *   uniform scale keeps the output one rectangle.
 * - Destination edges come from rounding *global* positions, so adjacent pieces tile
 *   exactly. When a piece's source size differs from its dest size (mixed DPI, or a
 *   scale override) the backend resamples.
 */
export function planCapture(rect: Rect, displays: readonly CaptureDisplay[], options: PlanOptions = {}): CapturePlan {
	if (!(rect.width > 0 && rect.height > 0) || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
		throw new RangeError(`capture rect must have a positive finite size, got ${JSON.stringify(rect)}`);
	}
	const hits: { d: CaptureDisplay; g: Rect }[] = [];
	for (const d of displays) {
		const g = intersection(rect, d.bounds);
		if (g) hits.push({ d, g });
	}
	const scale = options.scale ?? (hits.length > 0 ? Math.max(...hits.map((h) => h.d.scaleFactor)) : 1);
	if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError(`capture scale must be positive, got ${scale}`);
	const width = Math.max(1, Math.round(rect.width * scale));
	const height = Math.max(1, Math.round(rect.height * scale));
	const toOut = (v: number, origin: number, limit: number) =>
		Math.min(limit, Math.max(0, Math.round((v - origin) * scale)));

	const pieces: CapturePiece[] = [];
	let covered = 0;
	for (const { d, g } of hits) {
		const dx0 = toOut(g.x, rect.x, width);
		const dy0 = toOut(g.y, rect.y, height);
		const dx1 = toOut(right(g), rect.x, width);
		const dy1 = toOut(bottom(g), rect.y, height);
		if (dx1 <= dx0 || dy1 <= dy0) continue;
		covered += g.width * g.height;
		const source = toNative(g, d, options.snapSource ?? false);
		if (source.width <= 0 || source.height <= 0) continue;
		pieces.push({
			displayId: d.id,
			logical: g,
			source,
			sourceLocal: {
				x: source.x - d.nativeBounds.x,
				y: source.y - d.nativeBounds.y,
				width: source.width,
				height: source.height,
			},
			dest: { x: dx0, y: dy0, width: dx1 - dx0, height: dy1 - dy0 },
		});
	}
	// Displays never overlap (a mirror set is reported once), so less covered area than
	// the rect's area means part of it is off every display.
	const partial = covered + 1e-6 < rect.width * rect.height;
	return { rect, scale, width, height, pieces, partial };
}

/** Map a logical rect inside `d.bounds` to `d`'s native space, per axis. */
function toNative(g: Rect, d: CaptureDisplay, snap: boolean): Rect {
	const kx = d.nativeBounds.width / d.bounds.width;
	const ky = d.nativeBounds.height / d.bounds.height;
	let x0 = d.nativeBounds.x + (g.x - d.bounds.x) * kx;
	let y0 = d.nativeBounds.y + (g.y - d.bounds.y) * ky;
	let x1 = d.nativeBounds.x + (right(g) - d.bounds.x) * kx;
	let y1 = d.nativeBounds.y + (bottom(g) - d.bounds.y) * ky;
	if (snap) {
		x0 = Math.round(x0);
		y0 = Math.round(y0);
		x1 = Math.round(x1);
		y1 = Math.round(y1);
	}
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Attach native bounds to shell displays by id. Displays the backend doesn't know are
 * dropped (they can't be captured); the backend's extra displays are ignored.
 *
 * Windows: Electrobun's `Display.id` is the HMONITOR and glimpse.dll reports physical
 * monitor rects keyed by the same value. macOS: ids are CGDirectDisplayIDs and native
 * bounds are the logical bounds (`withLogicalNativeBounds`).
 */
export function withNativeBounds(
	shell: readonly Display[],
	native: readonly { readonly id: number; readonly bounds: Rect }[],
): CaptureDisplay[] {
	const byId = new Map(native.map((n) => [n.id, n.bounds]));
	const out: CaptureDisplay[] = [];
	for (const d of shell) {
		const nativeBounds = byId.get(d.id);
		if (nativeBounds && nativeBounds.width > 0 && nativeBounds.height > 0) out.push({ ...d, nativeBounds });
	}
	return out;
}

/** For backends whose native space is the logical space (macOS points). */
export const withLogicalNativeBounds = (shell: readonly Display[]): CaptureDisplay[] =>
	shell.map((d) => ({ ...d, nativeBounds: d.bounds }));
