// Picker geometry across displays (region-picker spec 4, 4.1, 4.2). Ported from
// spikes/overlay/src/shared/geometry.ts onto core's Rect/Display types.
//
// Spaces: everything is global logical (Electrobun's Screen space) unless a name says
// otherwise. "Native" means a backend's own space (Windows: physical virtual-desktop px).
import { contains, intersection, type Point, type Rect, translate } from "../geometry.ts";
import type { Display } from "../region.ts";

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;

/** Squared distance from p to r (0 inside). Edges count as inside. */
function distance2(r: Rect, p: Point): number {
	const dx = p.x < r.x ? r.x - p.x : p.x > right(r) ? p.x - right(r) : 0;
	const dy = p.y < r.y ? r.y - p.y : p.y > bottom(r) ? p.y - bottom(r) : 0;
	return dx * dx + dy * dy;
}

/** The display whose bounds contain p (right/bottom edges excluded), else the nearest one. */
export function displayAt<D extends Display>(displays: readonly D[], p: Point): D | null {
	let best: D | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const d of displays) {
		if (contains(d.bounds, p)) return d;
		const dist = distance2(d.bounds, p);
		if (dist < bestDist) {
			bestDist = dist;
			best = d;
		}
	}
	return best;
}

/** Clamp p into one rect (edges inclusive: a selection may end on the far edge). */
export function clampToRect(r: Rect, p: Point): Point {
	return { x: Math.min(Math.max(p.x, r.x), right(r)), y: Math.min(Math.max(p.y, r.y), bottom(r)) };
}

/**
 * Clamp p into the union of display bounds. A point in a gap between displays of
 * different sizes sticks to the nearest display's edge (spec 4, "Clamping").
 */
export function clampToDesktop(displays: readonly Display[], p: Point): Point {
	const d = displayAt(displays, p);
	if (!d) return p;
	if (distance2(d.bounds, p) === 0) return p;
	return clampToRect(d.bounds, p);
}

/** Bounding box of all displays (null with none). */
export function desktopBounds(displays: readonly Display[]): Rect | null {
	if (displays.length === 0) return null;
	let x = Number.POSITIVE_INFINITY;
	let y = Number.POSITIVE_INFINITY;
	let r = Number.NEGATIVE_INFINITY;
	let b = Number.NEGATIVE_INFINITY;
	for (const d of displays) {
		x = Math.min(x, d.bounds.x);
		y = Math.min(y, d.bounds.y);
		r = Math.max(r, right(d.bounds));
		b = Math.max(b, bottom(d.bounds));
	}
	return { x, y, width: r - x, height: b - y };
}

/**
 * Snap a rect so its edges land on whole device pixels of `display` (the one containing
 * its top-left corner). Edges are rounded, not the size, so adjacent pieces stay adjacent
 * at 125 % / 150 %.
 */
export function snapToDevicePixels(r: Rect, display: Display): Rect {
	const s = display.scaleFactor > 0 ? display.scaleFactor : 1;
	const ox = display.bounds.x;
	const oy = display.bounds.y;
	const snap = (v: number, o: number) => Math.round((v - o) * s) / s + o;
	const x = snap(r.x, ox);
	const y = snap(r.y, oy);
	return { x, y, width: snap(right(r), ox) - x, height: snap(bottom(r), oy) - y };
}

/** One display's share of a selection (spec 9.4 `PickerConfirmed.pieces`). */
export interface SelectionPiece {
	readonly displayId: number;
	/** The part on this display, global logical. */
	readonly logical: Rect;
	/** The same part relative to the display's top-left, logical. */
	readonly local: Rect;
	/** The same part relative to the display's top-left, device px (edges rounded). */
	readonly physical: Rect;
	readonly scale: number;
}

/** Split a global logical selection into per-display pieces, in display order. */
export function selectionPieces(selection: Rect, displays: readonly Display[]): SelectionPiece[] {
	const out: SelectionPiece[] = [];
	for (const d of displays) {
		const g = intersection(selection, d.bounds);
		if (!g) continue;
		const local = translate(g, -d.bounds.x, -d.bounds.y);
		const s = d.scaleFactor > 0 ? d.scaleFactor : 1;
		const x0 = Math.round(local.x * s);
		const y0 = Math.round(local.y * s);
		const physical = {
			x: x0,
			y: y0,
			width: Math.round(right(local) * s) - x0,
			height: Math.round(bottom(local) * s) - y0,
		};
		out.push({ displayId: d.id, logical: g, local, physical, scale: s });
	}
	return out;
}

/** True when the pieces sit on displays with different scale factors. */
export const spansMixedScale = (pieces: readonly SelectionPiece[]): boolean =>
	new Set(pieces.map((p) => p.scale)).size > 1;

/** A display with its bounds in some native space (see capture/plan.ts `CaptureDisplay`). */
export interface NativeMappedDisplay extends Display {
	readonly nativeBounds: Rect;
}

function nativeDisplayAt<D extends NativeMappedDisplay>(displays: readonly D[], p: Point): D | null {
	let best: D | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const d of displays) {
		if (contains(d.nativeBounds, p)) return d;
		const dist = distance2(d.nativeBounds, p);
		if (dist < bestDist) {
			bestDist = dist;
			best = d;
		}
	}
	return best;
}

function mapNative(d: NativeMappedDisplay, p: Point): Point {
	const kx = d.bounds.width / d.nativeBounds.width;
	const ky = d.bounds.height / d.nativeBounds.height;
	return { x: d.bounds.x + (p.x - d.nativeBounds.x) * kx, y: d.bounds.y + (p.y - d.nativeBounds.y) * ky };
}

/** A native-space point in global logical space, through the display that contains it. */
export function nativeToLogicalPoint(displays: readonly NativeMappedDisplay[], p: Point): Point | null {
	const d = nativeDisplayAt(displays, p);
	return d ? mapNative(d, p) : null;
}

/**
 * A native-space rect (Windows: physical px, e.g. a window's DWM frame) in global logical
 * space. Each corner maps through the display it lies on, so a window straddling a 150 %
 * and a 100 % monitor keeps both edges where the user sees them.
 */
export function nativeToLogicalRect(displays: readonly NativeMappedDisplay[], r: Rect): Rect | null {
	const tl = nativeToLogicalPoint(displays, { x: r.x, y: r.y });
	// The far edge belongs to the display holding the last pixel inside the rect.
	const last = { x: right(r) - 0.5, y: bottom(r) - 0.5 };
	const d = nativeDisplayAt(displays, last);
	if (!tl || !d) return null;
	const br = mapNative(d, { x: right(r), y: bottom(r) });
	return { x: tl.x, y: tl.y, width: Math.max(0, br.x - tl.x), height: Math.max(0, br.y - tl.y) };
}
