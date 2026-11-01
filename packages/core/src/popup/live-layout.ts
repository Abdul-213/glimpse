// Live popup sizing, docking and small presentational rules (live-popup.md §2.2, §3, §4, §10).
// Pure, global logical px.
//
//   placeLivePopup(region, displays, opts)  side, width, anchored edge and height limit,
//                                           computed once at pin time (the side is kept
//                                           for the session; re-pin recomputes it)
//   livePopupFrame(placement, height)       the window frame for a content height (same
//                                           rule as Snip: grown from the anchored edge,
//                                           on the device-pixel grid)
//   stripLayout(width)                      compact / regular / wide control strip
//   staleAge(capturedAt, now)               "just now" / "{n} min ago" / "over an hour ago"
//   announcementText(texts, max)            one screen-reader announcement (§10)
import type { Rect } from "../geometry.ts";
import { intersection } from "../geometry.ts";
import type { Display } from "../region.ts";
import { displayForRegion, type PlacementOptions, type SnipPopupPlacement, snipPopupFrame } from "./placement.ts";

export const LIVE_GAP = 8;
export const LIVE_MARGIN = 8;
export const LIVE_MIN_W = 240;
/** Below / above. */
export const LIVE_MAX_W = 640;
/** Inline-end / inline-start. */
export const LIVE_SIDE_MAX_W = 400;
export const LIVE_COMFORT_H = 160;
/** The strip plus one line. */
export const LIVE_MIN_H = 80;
export const LIVE_INSIDE_INSET = 8;

/** Same shape as the Snip placement, so the frame rule is shared. */
export type LivePopupPlacement = SnipPopupPlacement;

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Where the docked Live popup goes for a pinned `region` (live-popup.md §3). Side, first that
 * fits: below (≥ 160), above (≥ 160), inline-end (≥ 240 wide), inline-start, the larger of
 * below / above (≥ 80), else inside the region's top inline-end corner. Below / above are
 * centred on the region (subtitles are centred). Null when there are no displays.
 */
export function placeLivePopup(
	region: Rect,
	displays: readonly Display[],
	options: PlacementOptions = {},
): LivePopupPlacement | null {
	const display = displayForRegion(region, displays, options.pointer ?? null);
	if (!display) return null;
	const rtl = options.uiDir === "rtl";
	const wa = display.workArea;
	const M = LIVE_MARGIN;
	const G = LIVE_GAP;
	const usableW = Math.max(1, wa.width - 2 * M);
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
	const fullW = Math.min(clamp(region.width, LIVE_MIN_W, LIVE_MAX_W), usableW);
	const centredX = (w: number) => clamp(region.x + region.width / 2 - w / 2, wa.x + M, right(wa) - M - w);
	const vertical = (side: "below" | "above"): LivePopupPlacement => ({
		...base,
		side,
		width: fullW,
		maxHeight: Math.max(1, Math.min(0.4 * wa.height, side === "below" ? space.below : space.above)),
		x: centredX(fullW),
		anchor: side === "below" ? "top" : "bottom",
		y: side === "below" ? bottom(region) + G : region.y - G,
	});
	const side = (which: "inline-end" | "inline-start"): LivePopupPlacement => {
		const physicalRight = (which === "inline-end") !== rtl;
		const room = physicalRight ? space.right : space.left;
		const width = Math.min(clamp(room, LIVE_MIN_W, LIVE_SIDE_MAX_W), usableW);
		const maxHeight = Math.min(0.8 * wa.height, wa.height - 2 * M);
		return {
			...base,
			side: which,
			width,
			maxHeight,
			x: physicalRight ? right(region) + G : region.x - G - width,
			anchor: "top",
			y: clamp(region.y, wa.y + M, bottom(wa) - M - LIVE_MIN_H),
		};
	};

	if (space.below >= LIVE_COMFORT_H) return vertical("below");
	if (space.above >= LIVE_COMFORT_H) return vertical("above");
	const endRoom = rtl ? space.left : space.right;
	const startRoom = rtl ? space.right : space.left;
	if (endRoom >= LIVE_MIN_W) return side("inline-end");
	if (startRoom >= LIVE_MIN_W) return side("inline-start");
	if (Math.max(space.below, space.above) >= LIVE_MIN_H) {
		return vertical(space.below >= space.above ? "below" : "above");
	}

	// Inside: the top inline-end corner of the visible region, inset 8. It covers part of the
	// region on screen, but not in capture (our windows are excluded), so OCR is unaffected.
	const r = intersection(region, wa) ?? wa;
	const width = Math.max(Math.min(fullW, r.width - 2 * LIVE_INSIDE_INSET), Math.min(LIVE_MIN_W, usableW));
	const x = clamp(
		rtl ? r.x + LIVE_INSIDE_INSET : right(r) - LIVE_INSIDE_INSET - width,
		wa.x + M,
		right(wa) - M - width,
	);
	return {
		...base,
		side: "inside",
		width,
		maxHeight: Math.max(LIVE_MIN_H, Math.min(0.4 * wa.height, 0.4 * r.height)),
		x,
		anchor: "top",
		y: Math.max(r.y + LIVE_INSIDE_INSET, wa.y + M),
	};
}

/**
 * The window frame for a content height: the anchored edge never moves (below and sides:
 * the top; above: the bottom), capped at `maxHeight`, on the display's device-pixel grid.
 */
export function livePopupFrame(p: LivePopupPlacement, contentHeight: number): Rect {
	return snipPopupFrame(p, Math.max(LIVE_MIN_H, Number.isFinite(contentHeight) ? contentHeight : LIVE_MIN_H));
}

/** Control strip widths (§2.2): compact < 300 (icon-only local, no " · Private"), wide ≥ 360. */
export type LiveStripLayout = "compact" | "regular" | "wide";

export function stripLayout(width: number): LiveStripLayout {
	if (width < 300) return "compact";
	return width < 360 ? "regular" : "wide";
}

/** How old the shown text is while stale (§4 Staleness). The view words it. */
export type LiveStaleAge =
	| { readonly kind: "now" }
	| { readonly kind: "min"; readonly n: number }
	| { readonly kind: "hour" };

export function staleAge(capturedAt: number, now: number): LiveStaleAge {
	const s = Math.max(0, now - capturedAt) / 1000;
	if (s < 60) return { kind: "now" };
	if (s < 3600) return { kind: "min", n: Math.floor(s / 60) };
	return { kind: "hour" };
}

/** The stale label refreshes this often (§8). */
export const LIVE_STALE_REFRESH_MS = 30_000;

const SENTENCE_END = /[.!?。！？…]["'”’」』)]*$/u;

/**
 * One screen-reader announcement (§10): the new translations in reading order joined by ". ",
 * at most `max` characters, ending in "…" when cut. Empty when there is nothing to say.
 */
export function announcementText(texts: readonly string[], max = 300): string {
	let out = "";
	for (const raw of texts) {
		const t = raw.replace(/\s+/g, " ").trim();
		if (t === "") continue;
		if (out !== "") out += SENTENCE_END.test(out) ? " " : ". ";
		out += t;
	}
	if (out.length <= max) return out;
	const cut = out.slice(0, Math.max(0, max - 1));
	const space = cut.lastIndexOf(" ");
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
