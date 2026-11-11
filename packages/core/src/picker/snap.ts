// Window-edge snapping and snap candidates (region-picker spec 4 "Snap distance",
// "Snap edges", "Snap candidate"; 2 G, H).
import { contains, intersection, type Point, type Rect } from "../geometry.ts";
import type { Display } from "../region.ts";
import { desktopBounds, displayAt } from "./geometry.ts";
import type { ScreenWindow } from "./ports.ts";
import type { Guide, PickerMode } from "./types.ts";

/** Snap distance, logical px (spec 4). */
export const SNAP_DISTANCE = 6;
/** Windows smaller than this on either side are never candidates (spec 4). */
export const MIN_CANDIDATE = 40;

/** One edge a coordinate can snap to, with the extent its guide is drawn along. */
export interface SnapEdge {
	/** The x (for vertical edges) or y (horizontal edges) value. */
	readonly at: number;
	/** The guide's extent on the other axis. */
	readonly from: number;
	readonly to: number;
}

export interface SnapEdges {
	readonly x: readonly SnapEdge[];
	readonly y: readonly SnapEdge[];
}

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;

/**
 * Edges near `p` can snap to. x: left/right of every window whose vertical extent holds
 * p.y, plus every display's left/right bounds and work-area edges; y symmetric. Edges of
 * windows hidden behind nearer ones still count (spec 4).
 */
export function snapEdges(windows: readonly ScreenWindow[], displays: readonly Display[], p: Point): SnapEdges {
	const x: SnapEdge[] = [];
	const y: SnapEdge[] = [];
	for (const w of windows) {
		const r = w.rect;
		if (p.y >= r.y && p.y <= bottom(r)) {
			x.push({ at: r.x, from: r.y, to: bottom(r) }, { at: right(r), from: r.y, to: bottom(r) });
		}
		if (p.x >= r.x && p.x <= right(r)) {
			y.push({ at: r.y, from: r.x, to: right(r) }, { at: bottom(r), from: r.x, to: right(r) });
		}
	}
	for (const d of displays) {
		for (const r of [d.bounds, d.workArea]) {
			x.push(
				{ at: r.x, from: d.bounds.y, to: bottom(d.bounds) },
				{ at: right(r), from: d.bounds.y, to: bottom(d.bounds) },
			);
			y.push(
				{ at: r.y, from: d.bounds.x, to: right(d.bounds) },
				{ at: bottom(r), from: d.bounds.x, to: right(d.bounds) },
			);
		}
	}
	return { x, y };
}

function nearest(v: number, edges: readonly SnapEdge[], distance: number): SnapEdge | null {
	let best: SnapEdge | null = null;
	for (const e of edges) {
		const d = Math.abs(e.at - v);
		if (d <= distance && (best === null || d < Math.abs(best.at - v))) best = e;
	}
	return best;
}

export interface Snapped {
	readonly p: Point;
	readonly guides: readonly Guide[];
}

/** Snap x and y independently to the nearest edge within `distance` (spec 4). */
export function snapPoint(p: Point, edges: SnapEdges, distance = SNAP_DISTANCE): Snapped {
	const ex = nearest(p.x, edges.x, distance);
	const ey = nearest(p.y, edges.y, distance);
	const guides: Guide[] = [];
	if (ex) guides.push({ x1: ex.at, y1: ex.from, x2: ex.at, y2: ex.to });
	if (ey) guides.push({ x1: ey.from, y1: ey.at, x2: ey.to, y2: ey.at });
	return { p: { x: ex?.at ?? p.x, y: ey?.at ?? p.y }, guides };
}

export interface Candidate {
	readonly rect: Rect;
	/** The window, or null for the bare display. */
	readonly window: ScreenWindow | null;
	readonly displayId: number;
}

/**
 * The snap candidate under `p` (spec 4): the frontmost listed window containing it, else
 * the whole display. Clipped to the desktop (Snip) or to the pointer's display (Live).
 */
export function candidateAt(
	windows: readonly ScreenWindow[],
	displays: readonly Display[],
	p: Point,
	mode: PickerMode,
): Candidate | null {
	const display = displayAt(displays, p);
	if (!display) return null;
	const clip = mode === "live" ? display.bounds : desktopBounds(displays);
	for (const w of windows) {
		if (w.rect.width < MIN_CANDIDATE || w.rect.height < MIN_CANDIDATE) continue;
		if (!contains(w.rect, p)) continue;
		const rect = clip ? intersection(w.rect, clip) : w.rect;
		if (rect) return { rect, window: w, displayId: display.id };
	}
	return { rect: display.bounds, window: null, displayId: display.id };
}
