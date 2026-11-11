// Moving the docked Live popup (GLIM-151, live-popup.md §3.3). Pure, global logical px.
//
//   moveLivePopup(docked, origin, displays, height)  the placement for a popup put at
//                                                     `origin` (drag, keyboard, remembered
//                                                     offset): on one display, whole popup
//                                                     inside its work area, top-left fixed
//                                                     as the content grows
//   liveMoveStep(key, large)                         Alt/Option+arrows: 10 px, Shift 50 px
//   offsetFor / rememberOffset / forgetOffset        the moved offset relative to the
//                                                     region, per display (settings)
//
// A moved popup is anchored at its top: it grows downwards and its height limit is the room
// left below it, so growing never pushes it off screen and never moves its top-left.
import type { Point, Rect } from "../geometry.ts";
import type { Display } from "../region.ts";
import { LIVE_MARGIN, LIVE_MIN_H, type LivePopupPlacement } from "./live-layout.ts";
import { displayForRegion } from "./placement.ts";

/** One Alt/Option+arrow press. */
export const LIVE_MOVE_STEP = 10;
/** With Shift. */
export const LIVE_MOVE_STEP_LARGE = 50;
/** How many displays' offsets settings keep (oldest dropped first). */
export const LIVE_OFFSETS_MAX = 8;

/** A physical edge of the work area the popup was stopped at. */
export type LiveEdge = "left" | "right" | "top" | "bottom";

export type LiveMoveKey = "up" | "down" | "left" | "right";

/** Where a moved popup sits relative to the region's top-left, on the region's display. */
export interface LivePopupOffset {
	/** `displayKey` of the region's display. */
	readonly display: string;
	readonly dx: number;
	readonly dy: number;
}

export interface LiveMove {
	readonly placement: LivePopupPlacement;
	/** Edges the popup was held at (empty when it went exactly where asked). */
	readonly edges: readonly LiveEdge[];
}

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

/**
 * A display's identity across launches: its bounds and scale. Electrobun's display ids are
 * not promised to survive a restart; the arrangement is what "the same display" means here.
 */
export function displayKey(d: Display): string {
	const b = d.bounds;
	return `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)}x${Math.round(b.height)}@${d.scaleFactor}`;
}

/** Alt/Option+arrow: the step in physical screen directions (arrows are not mirrored in RTL). */
export function liveMoveStep(key: LiveMoveKey, large: boolean): Point {
	const n = large ? LIVE_MOVE_STEP_LARGE : LIVE_MOVE_STEP;
	switch (key) {
		case "up":
			return { x: 0, y: -n };
		case "down":
			return { x: 0, y: n };
		case "left":
			return { x: -n, y: 0 };
		case "right":
			return { x: n, y: 0 };
	}
}

/**
 * The placement for a popup moved to `origin` (its top-left). The display is the one the
 * popup's rectangle overlaps most (nearest when off every display); the popup is clamped
 * `LIVE_MARGIN` inside that work area with its current `height` visible, keeps the docked
 * width (narrowed only to fit the display), and is anchored at the top with the room below
 * it as its height limit. Null when there are no displays.
 */
export function moveLivePopup(
	docked: LivePopupPlacement,
	origin: Point,
	displays: readonly Display[],
	height: number = LIVE_MIN_H,
): LiveMove | null {
	const h0 = Math.max(LIVE_MIN_H, finite(height, LIVE_MIN_H));
	const wanted = { x: finite(origin.x, docked.x), y: finite(origin.y, docked.y) };
	const display = displayForRegion({ ...wanted, width: docked.width, height: h0 }, displays);
	if (!display) return null;
	const wa = display.workArea;
	const M = LIVE_MARGIN;
	const usableW = Math.max(1, wa.width - 2 * M);
	const width = Math.min(docked.width, usableW);
	// Whole popup visible at its current height, but never less than the strip plus a line.
	const visibleH = Math.min(h0, Math.max(LIVE_MIN_H, wa.height - 2 * M));
	const x = clamp(wanted.x, wa.x + M, right(wa) - M - width);
	const y = clamp(wanted.y, wa.y + M, bottom(wa) - M - visibleH);
	const edges: LiveEdge[] = [];
	if (wanted.x < x) edges.push("left");
	if (wanted.x > x) edges.push("right");
	if (wanted.y < y) edges.push("top");
	if (wanted.y > y) edges.push("bottom");
	const room = bottom(wa) - M - y;
	const cap = Math.max(docked.maxHeight, 0.4 * wa.height);
	return {
		placement: {
			displayId: display.id,
			scale: display.scaleFactor > 0 ? display.scaleFactor : 1,
			origin: { x: display.bounds.x, y: display.bounds.y },
			workArea: wa,
			side: docked.side,
			width,
			maxHeight: Math.max(LIVE_MIN_H, Math.min(cap, room)),
			x,
			anchor: "top",
			y,
		},
		edges,
	};
}

/** The new top-left for a move by `delta` from `frame`. */
export const movedOrigin = (frame: Point, delta: Point): Point => ({ x: frame.x + delta.x, y: frame.y + delta.y });

/** The remembered top-left for a popup pinned to `region`, or null when none is stored for its display. */
export function offsetFor(
	region: Rect,
	displays: readonly Display[],
	offsets: readonly LivePopupOffset[],
): Point | null {
	const display = displayForRegion(region, displays);
	if (!display) return null;
	const key = displayKey(display);
	const o = offsets.find((e) => e.display === key);
	return o ? { x: region.x + o.dx, y: region.y + o.dy } : null;
}

/** The offset list with `region`'s display set to the popup at `at` (newest last, capped). */
export function rememberOffset(
	offsets: readonly LivePopupOffset[],
	region: Rect,
	displays: readonly Display[],
	at: Point,
): readonly LivePopupOffset[] {
	const display = displayForRegion(region, displays);
	if (!display) return offsets;
	const key = displayKey(display);
	const entry = { display: key, dx: Math.round(at.x - region.x), dy: Math.round(at.y - region.y) };
	const rest = offsets.filter((e) => e.display !== key);
	return [...rest, entry].slice(-LIVE_OFFSETS_MAX);
}

/** The offset list without `region`'s display (Dock). */
export function forgetOffset(
	offsets: readonly LivePopupOffset[],
	region: Rect,
	displays: readonly Display[],
): readonly LivePopupOffset[] {
	const display = displayForRegion(region, displays);
	if (!display) return offsets;
	const key = displayKey(display);
	return offsets.some((e) => e.display === key) ? offsets.filter((e) => e.display !== key) : offsets;
}
