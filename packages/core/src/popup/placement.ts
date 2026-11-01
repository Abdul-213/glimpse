// Snip popup sizing and placement (snip-popup.md §3). Pure, global logical px.
//
//   placeSnipPopup(region, displays, opts)  where the popup goes: display, side, width,
//                                           the anchored edge and the height limit
//   snipPopupFrame(placement, contentHeight) the window frame for a content height, grown
//                                           from the anchored edge, rounded to the
//                                           display's device-pixel grid
//
// Side order, first that fits: below, above, inline-end, inline-start, the larger of
// below/above, then inside the region (the only case that may cover it).
import { area, contains, intersection, type Point, type Rect } from "../geometry.ts";
import type { Display } from "../region.ts";

/** Popup to region. */
export const POPUP_GAP = 8;
/** Popup to work-area edge. */
export const POPUP_MARGIN = 8;
export const POPUP_MIN_W = 280;
export const POPUP_MAX_W = 480;
/** About three blocks plus the footer. */
export const POPUP_COMFORT_H = 200;
/** One block plus the footer. */
export const POPUP_MIN_H = 96;
/** Share of the work area the popup may take. */
export const POPUP_MAX_SHARE = 0.6;
/** Inset of the inside fallback from the region's corner. */
export const POPUP_INSIDE_INSET = 8;

export type PopupSide = "below" | "above" | "inline-end" | "inline-start" | "inside";
export type UiDirection = "ltr" | "rtl";

export interface SnipPopupPlacement {
	readonly displayId: number;
	/** Device px per logical px of that display (frames are rounded to its grid). */
	readonly scale: number;
	/** The display's top-left (global logical): the device-pixel grid starts there. */
	readonly origin: Point;
	readonly workArea: Rect;
	readonly side: PopupSide;
	/** Fixed at show time; never changes while the popup is open. */
	readonly width: number;
	/** Height limit; past it the block list scrolls. */
	readonly maxHeight: number;
	/** Left edge (global logical). */
	readonly x: number;
	/**
	 * The anchored edge: `top` (below, sides: the popup grows down) or `bottom` (above,
	 * inside: it grows up). `y` is that edge's global logical coordinate.
	 */
	readonly anchor: "top" | "bottom";
	readonly y: number;
}

export interface PlacementOptions {
	readonly uiDir?: UiDirection;
	/** Pointer at confirm: breaks a tie between displays. */
	readonly pointer?: Point | null;
}

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * The display whose work area overlaps the region most; on a tie, the one under the
 * pointer; a region on no work area goes to the nearest display (primary first).
 */
export function displayForRegion(
	region: Rect,
	displays: readonly Display[],
	pointer: Point | null = null,
): Display | null {
	let best: Display | null = null;
	let bestArea = -1;
	for (const d of displays) {
		const a = area(intersection(region, d.workArea) ?? { x: 0, y: 0, width: 0, height: 0 });
		const tieWin = a === bestArea && pointer !== null && contains(d.bounds, pointer);
		if (a > bestArea || tieWin) {
			best = d;
			bestArea = a;
		}
	}
	if (best && bestArea > 0) return best;
	// No overlap at all: nearest display centre to the region centre.
	const cx = region.x + region.width / 2;
	const cy = region.y + region.height / 2;
	let nearest: Display | null = null;
	let nearestD = Number.POSITIVE_INFINITY;
	for (const d of displays) {
		const dx = Math.max(d.workArea.x - cx, 0, cx - right(d.workArea));
		const dy = Math.max(d.workArea.y - cy, 0, cy - bottom(d.workArea));
		const dist = dx * dx + dy * dy - (d.isPrimary ? 0.5 : 0);
		if (dist < nearestD) {
			nearest = d;
			nearestD = dist;
		}
	}
	return nearest;
}

/** Where the Snip popup goes for `region` (global logical). Null when there are no displays. */
export function placeSnipPopup(
	region: Rect,
	displays: readonly Display[],
	options: PlacementOptions = {},
): SnipPopupPlacement | null {
	const display = displayForRegion(region, displays, options.pointer ?? null);
	if (!display) return null;
	const rtl = options.uiDir === "rtl";
	const wa = display.workArea;
	const M = POPUP_MARGIN;
	const G = POPUP_GAP;
	const capH = Math.max(POPUP_MIN_H, Math.min(POPUP_MAX_SHARE * wa.height, wa.height - 2 * M));
	const fullW = Math.max(
		Math.min(POPUP_MIN_W, wa.width - 2 * M),
		Math.min(clamp(region.width, POPUP_MIN_W, POPUP_MAX_W), wa.width - 2 * M),
	);
	const base = {
		displayId: display.id,
		scale: display.scaleFactor > 0 ? display.scaleFactor : 1,
		origin: { x: display.bounds.x, y: display.bounds.y },
		workArea: wa,
	};

	const space = {
		below: bottom(wa) - bottom(region) - G - M,
		above: region.y - wa.y - G - M,
		right: right(wa) - right(region) - G - M,
		left: region.x - wa.x - G - M,
	};
	// Below/above: inline-start edges line up, then clamped into the work area.
	const alignedX = (w: number) => clamp(rtl ? right(region) - w : region.x, wa.x + M, right(wa) - M - w);
	const below = (): SnipPopupPlacement => ({
		...base,
		side: "below",
		width: fullW,
		maxHeight: Math.min(capH, space.below),
		x: alignedX(fullW),
		anchor: "top",
		y: bottom(region) + G,
	});
	const above = (): SnipPopupPlacement => ({
		...base,
		side: "above",
		width: fullW,
		maxHeight: Math.min(capH, space.above),
		x: alignedX(fullW),
		anchor: "bottom",
		y: region.y - G,
	});
	// Sides: tops line up; the popup slides up only when its bottom would cross the margin.
	const side = (which: "inline-end" | "inline-start"): SnipPopupPlacement => {
		const physicalRight = (which === "inline-end") !== rtl;
		const room = physicalRight ? space.right : space.left;
		const width = Math.min(fullW, room);
		return {
			...base,
			side: which,
			width,
			maxHeight: capH,
			x: physicalRight ? right(region) + G : region.x - G - width,
			anchor: "top",
			y: clamp(region.y, wa.y + M, bottom(wa) - M - POPUP_MIN_H),
		};
	};

	if (space.below >= POPUP_COMFORT_H) return below();
	if (space.above >= POPUP_COMFORT_H) return above();
	const endRoom = rtl ? space.left : space.right;
	const startRoom = rtl ? space.right : space.left;
	if (endRoom >= POPUP_MIN_W) return side("inline-end");
	if (startRoom >= POPUP_MIN_W) return side("inline-start");
	if (Math.max(space.below, space.above) >= POPUP_MIN_H) return space.below >= space.above ? below() : above();

	// Inside: the bottom inline-end corner of the (visible part of the) region, inset 8px.
	const r = intersection(region, wa) ?? wa;
	const width = Math.max(Math.min(fullW, r.width - 2 * POPUP_INSIDE_INSET), Math.min(POPUP_MIN_W, wa.width - 2 * M));
	const x = clamp(
		rtl ? r.x + POPUP_INSIDE_INSET : right(r) - POPUP_INSIDE_INSET - width,
		wa.x + M,
		right(wa) - M - width,
	);
	return {
		...base,
		side: "inside",
		width,
		maxHeight: Math.min(capH, Math.max(POPUP_MIN_H, POPUP_MAX_SHARE * r.height)),
		x,
		anchor: "bottom",
		y: Math.min(bottom(r) - POPUP_INSIDE_INSET, bottom(wa) - M),
	};
}

/**
 * The popup's window frame for a content height: grown from the anchored edge, capped at
 * `maxHeight`, kept inside the work area margin, and rounded to the display's device-pixel
 * grid (origin and size), so text never lands on half pixels.
 */
export function snipPopupFrame(p: SnipPopupPlacement, contentHeight: number): Rect {
	const M = POPUP_MARGIN;
	const wa = p.workArea;
	const h = Math.max(1, Math.min(Number.isFinite(contentHeight) ? contentHeight : POPUP_MIN_H, p.maxHeight));
	let y = p.anchor === "top" ? p.y : p.y - h;
	if (p.side === "inline-end" || p.side === "inline-start") y = Math.min(y, bottom(wa) - M - h);
	y = Math.max(y, wa.y + M);
	const s = p.scale;
	const size = (v: number) => Math.round(v * s) / s;
	const at = (v: number, o: number) => Math.round((v - o) * s) / s + o;
	return { x: at(p.x, p.origin.x), y: at(y, p.origin.y), width: size(p.width), height: Math.max(1 / s, size(h)) };
}

/** The popup edge that faces the region (the enter animation grows from it). */
export function facingEdge(side: PopupSide): "top" | "bottom" | "inline-start" | "inline-end" {
	switch (side) {
		case "below":
			return "top";
		case "above":
		case "inside":
			return "bottom";
		case "inline-end":
			return "inline-start";
		case "inline-start":
			return "inline-end";
	}
}
