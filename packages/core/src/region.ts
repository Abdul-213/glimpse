import { intersection, type Rect, scaleToPixels, translate } from "./geometry.ts";

/** One physical display as the shell reports it (Electrobun `Screen.getAllDisplays()`). */
export interface Display {
	readonly id: number;
	/** Global logical bounds. */
	readonly bounds: Rect;
	/** Global logical work area (bounds minus menu bar, Dock, taskbar). */
	readonly workArea: Rect;
	/** Device pixels per logical unit (1, 1.25, 1.5, 2, ...). */
	readonly scaleFactor: number;
	readonly isPrimary: boolean;
}

/**
 * A screen area the user picked. A region never spans displays: the picker runs one
 * overlay per display and clips the selection to it.
 */
export interface Region {
	readonly displayId: number;
	/** Global logical bounds, inside the display's bounds. */
	readonly bounds: Rect;
}

/** Clip a global logical selection to one display. Null when it misses the display. */
export function regionOnDisplay(selection: Rect, display: Display): Region | null {
	const clipped = intersection(selection, display.bounds);
	return clipped ? { displayId: display.id, bounds: clipped } : null;
}

/**
 * The region in the display's own device pixels (origin at the display's top-left),
 * which is what capture backends take and what OCR boxes are relative to.
 */
export function regionToDisplayPixels(region: Region, display: Display): Rect {
	if (region.displayId !== display.id) {
		throw new Error(`region is on display ${region.displayId}, not ${display.id}`);
	}
	const local = translate(region.bounds, -display.bounds.x, -display.bounds.y);
	return scaleToPixels(local, display.scaleFactor);
}
