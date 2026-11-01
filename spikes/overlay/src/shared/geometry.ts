// Pure coordinate maths for the region picker. No Electrobun or DOM imports,
// so `bun test` can exercise it on any OS.
//
// Coordinate spaces used throughout the spike:
//
//   global logical  Electrobun's Screen space. Top-left origin at the primary
//                   display. Units are macOS points / Windows DIPs. On Windows
//                   Electrobun lays monitors out Chromium-style (primary-rooted,
//                   each monitor sized physical/scale, touching edges kept), see
//                   package/src/native/shared/windows_dpi.h.
//   local logical   CSS px inside one overlay webview (= points/DIPs on that
//                   display, assuming page zoom 1).
//   local physical  Device pixels inside one display (local logical * scale).
//   global physical Windows only: the real virtual-screen pixel space that
//                   GetCursorPos / BitBlt / DXGI use under per-monitor-v2 DPI
//                   awareness. macOS has no global pixel space; capture APIs
//                   (ScreenCaptureKit, CGDisplayCreateImage) are per display.

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A display as returned by Electrobun's Screen.getAllDisplays(), plus native extras. */
export interface DisplayInfo {
	id: number;
	/** Global logical bounds (Electrobun). */
	bounds: Rect;
	workArea: Rect;
	scaleFactor: number;
	isPrimary: boolean;
	/**
	 * Windows: physical monitor rect from GetMonitorInfoW (virtual-screen pixels).
	 * macOS: null (no global pixel space).
	 */
	physicalBounds: Rect | null;
}

export interface DisplayPiece {
	displayId: number;
	scaleFactor: number;
	isPrimary: boolean;
	/** Intersection of the selection with this display, global logical. */
	globalLogical: Rect;
	/** Same piece relative to the display's top-left, logical. */
	localLogical: Rect;
	/** Same piece relative to the display's top-left, device pixels (edges rounded). */
	localPhysical: Rect;
	/** Windows only: the piece in global physical pixels. */
	globalPhysical: Rect | null;
}

export interface SelectionReport {
	globalLogical: Rect;
	/**
	 * Windows only: bounding box of the per-display globalPhysical pieces.
	 * When the selection spans displays with different scales this is NOT a
	 * faithful 1:1 image of the logical rect; use the pieces for capture.
	 */
	globalPhysicalBounds: Rect | null;
	pieces: DisplayPiece[];
	spansMixedScale: boolean;
}

export const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };

export function rectFromPoints(a: Point, b: Point): Rect {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function rectRight(r: Rect): number {
	return r.x + r.width;
}

export function rectBottom(r: Rect): number {
	return r.y + r.height;
}

export function isEmpty(r: Rect): boolean {
	return !(r.width > 0 && r.height > 0);
}

export function intersect(a: Rect, b: Rect): Rect | null {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(rectRight(a), rectRight(b));
	const bottom = Math.min(rectBottom(a), rectBottom(b));
	if (right <= x || bottom <= y) return null;
	return { x, y, width: right - x, height: bottom - y };
}

export function unionRects(rects: Rect[]): Rect | null {
	if (rects.length === 0) return null;
	let x = Infinity;
	let y = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const r of rects) {
		x = Math.min(x, r.x);
		y = Math.min(y, r.y);
		right = Math.max(right, rectRight(r));
		bottom = Math.max(bottom, rectBottom(r));
	}
	return { x, y, width: right - x, height: bottom - y };
}

export function containsPoint(r: Rect, p: Point): boolean {
	return p.x >= r.x && p.x < rectRight(r) && p.y >= r.y && p.y < rectBottom(r);
}

export function translate(r: Rect, dx: number, dy: number): Rect {
	return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height };
}

/** The display whose logical bounds contain p, else the nearest one. */
export function displayForPoint(displays: DisplayInfo[], p: Point): DisplayInfo | null {
	if (displays.length === 0) return null;
	const hit = displays.find((d) => containsPoint(d.bounds, p));
	if (hit) return hit;
	let best: DisplayInfo | null = null;
	let bestDist = Infinity;
	for (const d of displays) {
		const dx = p.x < d.bounds.x ? d.bounds.x - p.x : p.x >= rectRight(d.bounds) ? p.x - rectRight(d.bounds) + 1 : 0;
		const dy = p.y < d.bounds.y ? d.bounds.y - p.y : p.y >= rectBottom(d.bounds) ? p.y - rectBottom(d.bounds) + 1 : 0;
		const dist = dx * dx + dy * dy;
		if (dist < bestDist) {
			bestDist = dist;
			best = d;
		}
	}
	return best;
}

/** Clamp a point into the union of display bounds (to the nearest display's edge). */
export function clampToDesktop(displays: DisplayInfo[], p: Point): Point {
	const d = displayForPoint(displays, p);
	if (!d) return p;
	if (containsPoint(d.bounds, p)) return p;
	return {
		x: Math.min(Math.max(p.x, d.bounds.x), rectRight(d.bounds)),
		y: Math.min(Math.max(p.y, d.bounds.y), rectBottom(d.bounds)),
	};
}

/**
 * Snap a global logical rect so that, on the given display, both edges land on
 * whole device pixels. Scaling edges (not size) keeps adjacent pieces adjacent
 * at fractional scales such as 1.25 / 1.5, matching Electrobun's own
 * logicalToPhysicalRect.
 */
export function snapToDevicePixels(r: Rect, display: DisplayInfo): Rect {
	const s = display.scaleFactor || 1;
	const ox = display.bounds.x;
	const oy = display.bounds.y;
	const left = Math.round((r.x - ox) * s) / s + ox;
	const top = Math.round((r.y - oy) * s) / s + oy;
	const right = Math.round((rectRight(r) - ox) * s) / s + ox;
	const bottom = Math.round((rectBottom(r) - oy) * s) / s + oy;
	return { x: left, y: top, width: right - left, height: bottom - top };
}

function localPhysicalFor(localLogical: Rect, scale: number): Rect {
	const left = Math.round(localLogical.x * scale);
	const top = Math.round(localLogical.y * scale);
	const right = Math.round(rectRight(localLogical) * scale);
	const bottom = Math.round(rectBottom(localLogical) * scale);
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Split a global logical selection into per-display pieces with physical coordinates. */
export function describeSelection(selection: Rect, displays: DisplayInfo[]): SelectionReport {
	const pieces: DisplayPiece[] = [];
	for (const d of displays) {
		const g = intersect(selection, d.bounds);
		if (!g) continue;
		const localLogical = translate(g, -d.bounds.x, -d.bounds.y);
		const localPhysical = localPhysicalFor(localLogical, d.scaleFactor || 1);
		const globalPhysical = d.physicalBounds
			? translate(localPhysical, d.physicalBounds.x, d.physicalBounds.y)
			: null;
		pieces.push({
			displayId: d.id,
			scaleFactor: d.scaleFactor,
			isPrimary: d.isPrimary,
			globalLogical: g,
			localLogical,
			localPhysical,
			globalPhysical,
		});
	}
	const physicalPieces = pieces.map((p) => p.globalPhysical).filter((r): r is Rect => r !== null);
	const scales = new Set(pieces.map((p) => p.scaleFactor));
	return {
		globalLogical: selection,
		globalPhysicalBounds: physicalPieces.length === pieces.length ? unionRects(physicalPieces) : null,
		pieces,
		spansMixedScale: scales.size > 1,
	};
}

/** Global logical point -> Windows global physical point, via the display containing it. */
export function logicalToGlobalPhysical(displays: DisplayInfo[], p: Point): Point | null {
	const d = displayForPoint(displays, p);
	if (!d || !d.physicalBounds) return null;
	const s = d.scaleFactor || 1;
	return {
		x: d.physicalBounds.x + Math.round((p.x - d.bounds.x) * s),
		y: d.physicalBounds.y + Math.round((p.y - d.bounds.y) * s),
	};
}

/** Live size readout text: logical size plus device-pixel size on the display under the cursor. */
export function sizeLabel(selection: Rect, displays: DisplayInfo[]): string {
	const w = Math.round(selection.width);
	const h = Math.round(selection.height);
	const report = describeSelection(selection, displays);
	if (report.pieces.length === 0) return `${w} × ${h}`;
	if (report.pieces.length === 1) {
		const p = report.pieces[0]!;
		if (p.scaleFactor === 1) return `${w} × ${h}`;
		return `${w} × ${h} pt · ${p.localPhysical.width} × ${p.localPhysical.height} px @${p.scaleFactor}x`;
	}
	const mixed = report.spansMixedScale ? ", mixed DPI" : "";
	return `${w} × ${h} pt · ${report.pieces.length} displays${mixed}`;
}
