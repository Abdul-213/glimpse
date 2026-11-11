// Plain geometry used everywhere a rectangle crosses a boundary (picker -> capture,
// OCR -> popup placement). Two coordinate spaces exist and every value says which
// one it is in by its type's doc comment:
//
//   logical  - OS points / CSS px. Electrobun's Screen API and BrowserWindow frames.
//              Global logical space spans all displays, origin at the primary's top-left.
//   physical - device pixels of one display's framebuffer, origin at that display's
//              top-left. Capture backends and OCR boxes use this.

export interface Point {
	readonly x: number;
	readonly y: number;
}

export interface Size {
	readonly width: number;
	readonly height: number;
}

export interface Rect extends Point, Size {}

export const rect = (x: number, y: number, width: number, height: number): Rect => ({
	x,
	y,
	width,
	height,
});

/** The rectangle spanned by two drag points, whatever order they were pressed in. */
export function rectFromPoints(a: Point, b: Point): Rect {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export const area = (r: Rect): number => Math.max(0, r.width) * Math.max(0, r.height);

export const isEmpty = (r: Rect): boolean => r.width <= 0 || r.height <= 0;

export function contains(r: Rect, p: Point): boolean {
	return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

/** Overlap of two rectangles, or null when they only touch or are disjoint. */
export function intersection(a: Rect, b: Rect): Rect | null {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	if (right <= x || bottom <= y) return null;
	return { x, y, width: right - x, height: bottom - y };
}

export const translate = (r: Rect, dx: number, dy: number): Rect => ({
	...r,
	x: r.x + dx,
	y: r.y + dy,
});

/**
 * Scale a rectangle and snap it outward to whole pixels, so a logical selection never
 * loses a partly covered device pixel at its edges.
 */
export function scaleToPixels(r: Rect, factor: number): Rect {
	const x = Math.floor(r.x * factor);
	const y = Math.floor(r.y * factor);
	const right = Math.ceil((r.x + r.width) * factor);
	const bottom = Math.ceil((r.y + r.height) * factor);
	return { x, y, width: right - x, height: bottom - y };
}
