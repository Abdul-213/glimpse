// Where the picker's HUD chips go (region-picker spec 4 "Readout position", "Loupe
// position", "Hint bar position"; 4.1). Global logical in, global logical out.
import { intersection, type Point, type Rect, type Size } from "../geometry.ts";
import type { Display } from "../region.ts";
import { displayAt } from "./geometry.ts";

/** Gap between a selection edge and the readout chip (spec 4). */
export const READOUT_GAP = 8;
export const READOUT_HEIGHT = 20;
/** Loupe chip: 120 x 120 CSS px, 24 px right of and below the hotspot (spec 2 C, 4). */
export const LOUPE_SIZE = 120;
export const LOUPE_OFFSET = 24;
export const LOUPE_EDGE = 8;
/** Hint bar: 16 px from the work area's top (or bottom) edge; flees within 48 px (spec 4). */
export const HINT_MARGIN = 16;
export const HINT_HEIGHT = 28;
export const HINT_AVOID = 48;

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;

export type UiDir = "ltr" | "rtl";

export interface Placement {
	/** Top-left of the chip, global logical. */
	readonly at: Point;
	/** The display that draws it. */
	readonly displayId: number;
}

/**
 * The size readout: 8 px outside the selection's bottom-right corner (bottom-left in an
 * RTL UI). Each axis flips to the other side when the chip would leave the display, and
 * goes 8 px inside the selection when neither side fits.
 */
export function readoutPosition(
	selection: Rect,
	chip: Size,
	displays: readonly Display[],
	dir: UiDir = "ltr",
): Placement | null {
	const cornerX = dir === "rtl" ? selection.x : right(selection);
	const corner = { x: cornerX, y: bottom(selection) };
	// The corner lies on the far edge; look it up just inside the selection.
	const display = displayAt(displays, { x: dir === "rtl" ? corner.x : corner.x - 0.5, y: corner.y - 0.5 });
	if (!display) return null;
	const b = display.bounds;
	const fitsX = (x: number) => x >= b.x && x + chip.width <= right(b);
	const fitsY = (y: number) => y >= b.y && y + chip.height <= bottom(b);

	const outsideEnd = right(selection) + READOUT_GAP;
	const outsideStart = selection.x - READOUT_GAP - chip.width;
	const [firstX, secondX] = dir === "rtl" ? [outsideStart, outsideEnd] : [outsideEnd, outsideStart];
	const insideX = dir === "rtl" ? selection.x + READOUT_GAP : right(selection) - READOUT_GAP - chip.width;
	const x = fitsX(firstX) ? firstX : fitsX(secondX) ? secondX : insideX;

	const below = bottom(selection) + READOUT_GAP;
	const above = selection.y - READOUT_GAP - chip.height;
	const insideY = bottom(selection) - READOUT_GAP - chip.height;
	const y = fitsY(below) ? below : fitsY(above) ? above : insideY;
	return { at: { x, y }, displayId: display.id };
}

/**
 * The loupe: 24 px right of and below the hotspot; flips left / up when it would come
 * within 8 px of the display's right / bottom edge. Drawn only on the pointer's display.
 */
export function loupePosition(cursor: Point, display: Display, size = LOUPE_SIZE): Placement {
	const b = display.bounds;
	let x = cursor.x + LOUPE_OFFSET;
	let y = cursor.y + LOUPE_OFFSET;
	if (x + size > right(b) - LOUPE_EDGE) x = cursor.x - LOUPE_OFFSET - size;
	if (y + size > bottom(b) - LOUPE_EDGE) y = cursor.y - LOUPE_OFFSET - size;
	return { at: { x, y }, displayId: display.id };
}

export type HintPlacement = "top" | "bottom";

/** The hint bar's rect for a placement, centred on the work area. */
export function hintRect(workArea: Rect, bar: Size, placement: HintPlacement): Rect {
	const width = Math.min(bar.width, Math.max(0, workArea.width - 2 * HINT_MARGIN));
	const x = workArea.x + (workArea.width - width) / 2;
	const y = placement === "top" ? workArea.y + HINT_MARGIN : bottom(workArea) - HINT_MARGIN - bar.height;
	return { x, y, width, height: bar.height };
}

const grow = (r: Rect, by: number): Rect => ({
	x: r.x - by,
	y: r.y - by,
	width: r.width + 2 * by,
	height: r.height + 2 * by,
});

function blocked(bar: Rect, cursor: Point | null, selection: Rect | null): boolean {
	const zone = grow(bar, HINT_AVOID);
	if (cursor && cursor.x >= zone.x && cursor.x <= right(zone) && cursor.y >= zone.y && cursor.y <= bottom(zone)) {
		return true;
	}
	return !!selection && intersection(selection, zone) !== null;
}

/**
 * Top centre of the pointer's work area, unless the pointer or the selection comes
 * within 48 px of it; then the bottom (spec 4). It jumps, never animates. With both
 * spots blocked it stays where it was.
 */
export function hintPlacement(
	workArea: Rect,
	bar: Size,
	cursor: Point | null,
	selection: Rect | null,
	current: HintPlacement = "top",
): HintPlacement {
	const top = blocked(hintRect(workArea, bar, "top"), cursor, selection);
	if (!top) return "top";
	const bot = blocked(hintRect(workArea, bar, "bottom"), cursor, selection);
	if (!bot) return "bottom";
	return current;
}

/** Estimated readout chip width before the view has measured it: 12 px padding + tabular digits. */
export const estimateReadoutWidth = (text: string): number => Math.ceil(12 + 7.2 * [...text].length);
