// The pinned Live frame's look (GLIM-90, live-popup.md §2.4), as pure data: the geometry the
// native helpers draw (frame.m / frame.cpp mirror these constants), the tag copy, and the
// DESIGN.md colours they paint with. Tested on Linux; the helpers are checked on hardware.
import type { Rect } from "@glimpse/core";

/** Logical px (points on macOS; × the display scale on Windows). */
export const FRAME_GEOMETRY = {
	margin: 16,
	tagMargin: 40,
	arm: 12,
	stroke: 2,
	gap: 1,
	halo: 1,
	tagHeight: 20,
	tagPadding: 6,
	tagGap: 4,
	radiusBox: 3,
	radiusTag: 4,
	fontSize: 12,
} as const;

/** DESIGN.md colour tokens the frame uses, in the helpers' palette order. */
export const FRAME_COLORS = {
	accent: "#0A63C9",
	"picker-halo": "#00000099",
	"picker-stroke": "#FFFFFF",
	"picker-hud": "#1C1C1EE0",
	"picker-hud-text": "#F5F5F7",
	"box-linked-fill": "#0A63C93D",
	"egress-dark": "#C4B0FF",
} as const;

export type FrameTag =
	| { readonly kind: "none" }
	| { readonly kind: "live" }
	| { readonly kind: "paused" }
	| { readonly kind: "cloud"; readonly company: string };

/** live-popup.md §11 `live.tag*`. The cloud tag starts with a cloud glyph. */
export function frameTagText(tag: FrameTag): string {
	switch (tag.kind) {
		case "live":
			return "Live";
		case "paused":
			return "Live · Paused";
		case "cloud":
			return `☁︎ Live · ${tag.company}`;
		default:
			return "";
	}
}

export interface FrameLayout {
	/** The frame window, global logical. */
	readonly window: Rect;
	/** Eight tick arms (two per corner), global logical. */
	readonly ticks: readonly Rect[];
	/** The tag chip's box (its width depends on the text, measured natively): x, y, height. */
	readonly tag: { readonly x: number; readonly y: number; readonly height: number } | null;
	readonly tagBelow: boolean;
}

/**
 * Where the frame window and its ticks go for `region` (global logical). The tag sits 4 px
 * above the top-left tick, or below the bottom-left one when there's no room above on the
 * region's display (`displayTop`, its top edge).
 */
export function pinnedFrameLayout(
	region: Rect,
	options: { readonly tag: boolean; readonly displayTop: number },
): FrameLayout {
	const g = FRAME_GEOMETRY;
	const off = g.gap + g.stroke;
	const tagBelow = options.tag && region.y - off - g.tagGap - g.tagHeight < options.displayTop;
	const top = options.tag && !tagBelow ? g.tagMargin : g.margin;
	const bottom = options.tag && tagBelow ? g.tagMargin : g.margin;
	const window: Rect = {
		x: region.x - g.margin,
		y: region.y - top,
		width: region.width + 2 * g.margin,
		height: region.height + top + bottom,
	};
	const L = region.x - off;
	const T = region.y - off;
	const R = region.x + region.width + off;
	const B = region.y + region.height + off;
	const ticks: Rect[] = [];
	const corner = (ox: number, oy: number, dx: 1 | -1, dy: 1 | -1) => {
		ticks.push({ x: dx > 0 ? ox : ox - g.arm, y: dy > 0 ? oy : oy - g.stroke, width: g.arm, height: g.stroke });
		ticks.push({ x: dx > 0 ? ox : ox - g.stroke, y: dy > 0 ? oy : oy - g.arm, width: g.stroke, height: g.arm });
	};
	corner(L, T, 1, 1);
	corner(R, T, -1, 1);
	corner(L, B, 1, -1);
	corner(R, B, -1, -1);
	const tag = options.tag
		? {
				x: L,
				y: tagBelow ? B + g.tagGap : T - g.tagGap - g.tagHeight,
				height: g.tagHeight,
			}
		: null;
	return { window, ticks, tag, tagBelow };
}
