// Pure geometry for region capture. No FFI, no OS calls: unit-tested on Linux.
//
// Coordinate spaces (see FINDINGS.md "Coordinates"):
//   macOS   - "global points": one space for all displays, origin at the top-left
//             of the primary display, y down (CoreGraphics / ScreenCaptureKit
//             convention). A display with scale 2 has 2x2 pixels per point.
//   Windows - "physical pixels": the virtual-desktop coordinates a
//             per-monitor-DPI-aware (PMv2) process sees. All monitors share one
//             pixel grid, so a region spanning monitors is still one rectangle.
//   Electrobun logical (Windows only) - Electrobun's Screen API synthesizes a
//             DIP space by laying monitors out at their logical sizes. It must be
//             converted per monitor before capture.

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A display as reported by the native library. */
export interface NativeDisplay {
	id: number;
	/** Bounds in the backend's capture space (points on macOS, physical px on Windows). */
	bounds: Rect;
	/** Native pixels per unit of `bounds` (macOS: backing scale; Windows: always 1). */
	pixelScale: number;
	/** OS UI scale (macOS backing scale; Windows dpi/96). Informational. */
	uiScale: number;
	primary: boolean;
	name?: string;
}

/** One per-display piece of a capture, with where it lands in the output buffer. */
export interface CapturePiece {
	displayId: number;
	/** Source rect in display-local units (points on macOS, physical px on Windows). */
	local: Rect;
	/** Same rect in global units. */
	global: Rect;
	/** Destination rect in output pixels (integers). */
	dest: Rect;
}

export interface CapturePlan {
	region: Rect;
	/** Output pixels per region unit. */
	scale: number;
	outWidth: number;
	outHeight: number;
	pieces: CapturePiece[];
	/** True when part of the region is not on any display (left black). */
	hasUncovered: boolean;
}

export function rectRight(r: Rect): number {
	return r.x + r.width;
}
export function rectBottom(r: Rect): number {
	return r.y + r.height;
}
export function rectArea(r: Rect): number {
	return Math.max(0, r.width) * Math.max(0, r.height);
}

export function intersect(a: Rect, b: Rect): Rect | null {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const r = Math.min(rectRight(a), rectRight(b));
	const btm = Math.min(rectBottom(a), rectBottom(b));
	if (r <= x || btm <= y) return null;
	return { x, y, width: r - x, height: btm - y };
}

export function union(rects: Rect[]): Rect | null {
	if (rects.length === 0) return null;
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const r of rects) {
		x0 = Math.min(x0, r.x);
		y0 = Math.min(y0, r.y);
		x1 = Math.max(x1, rectRight(r));
		y1 = Math.max(y1, rectBottom(r));
	}
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Parse "x,y,w,h" (also accepts spaces / "x y w h"). Negative x/y are valid. */
export function parseRect(text: string): Rect {
	const parts = text
		.trim()
		.split(/[\s,]+/)
		.filter((p) => p.length > 0)
		.map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
		throw new Error(`expected "x,y,width,height", got "${text}"`);
	}
	const [x, y, width, height] = parts as [number, number, number, number];
	if (width <= 0 || height <= 0) {
		throw new Error(`width and height must be positive, got ${width}x${height}`);
	}
	return { x, y, width, height };
}

export function formatRect(r: Rect): string {
	return `${r.x},${r.y},${r.width},${r.height}`;
}

/**
 * Split a global region into per-display pieces and compute where each lands in
 * the output buffer.
 *
 * `scale` defaults to the highest pixelScale among the displays the region
 * touches, so a region spanning a Retina (2x) and a 1x display keeps full
 * detail on the Retina part and upsamples the 1x part. OCR wants the detail;
 * a uniform output scale keeps the buffer a simple rectangle.
 *
 * Destination edges are computed by rounding the *global* edge positions, so
 * adjacent pieces tile exactly with no gap or overlap.
 */
export function planCapture(
	region: Rect,
	displays: NativeDisplay[],
	scaleOverride?: number,
): CapturePlan {
	const hits: { d: NativeDisplay; g: Rect }[] = [];
	for (const d of displays) {
		const g = intersect(region, d.bounds);
		if (g) hits.push({ d, g });
	}
	const scale =
		scaleOverride ??
		(hits.length > 0 ? Math.max(...hits.map((h) => h.d.pixelScale)) : 1);
	const outWidth = Math.max(1, Math.round(region.width * scale));
	const outHeight = Math.max(1, Math.round(region.height * scale));
	const toOut = (v: number, origin: number, limit: number) =>
		Math.min(limit, Math.max(0, Math.round((v - origin) * scale)));

	const pieces: CapturePiece[] = [];
	let covered = 0;
	for (const { d, g } of hits) {
		const dx0 = toOut(g.x, region.x, outWidth);
		const dy0 = toOut(g.y, region.y, outHeight);
		const dx1 = toOut(rectRight(g), region.x, outWidth);
		const dy1 = toOut(rectBottom(g), region.y, outHeight);
		if (dx1 <= dx0 || dy1 <= dy0) continue;
		covered += rectArea(g);
		pieces.push({
			displayId: d.id,
			global: g,
			local: {
				x: g.x - d.bounds.x,
				y: g.y - d.bounds.y,
				width: g.width,
				height: g.height,
			},
			dest: { x: dx0, y: dy0, width: dx1 - dx0, height: dy1 - dy0 },
		});
	}
	// Displays never overlap on macOS or Windows (mirroring reports one), so
	// summed piece area < region area means part of the region is off-screen.
	const hasUncovered = covered + 1e-6 < rectArea(region);
	return { region, scale, outWidth, outHeight, pieces, hasUncovered };
}

/** Electrobun's Display shape (logical coordinates). */
export interface ElectrobunDisplay {
	id: number;
	bounds: Rect;
	scaleFactor: number;
	isPrimary: boolean;
}

/**
 * Convert a rect in Electrobun's logical space to the native capture space.
 *
 * macOS: Electrobun's logical space *is* global points, so this is identity.
 * Windows: each monitor has a logical rect (Electrobun) and a physical rect
 * (native, matched by HMONITOR id). The rect is split per logical monitor,
 * each part is mapped with that monitor's origin and scale, and the physical
 * bounding box is returned along with the parts. With mixed DPI the parts may
 * not form a perfect rectangle in physical space; callers capture the bounding
 * box and the parts tell the overlay which pixels the user actually selected.
 */
export function logicalToNative(
	rect: Rect,
	logical: ElectrobunDisplay[],
	native: NativeDisplay[],
	platform: "darwin" | "win32" | string,
): { bounds: Rect; parts: Rect[] } {
	if (platform !== "win32") return { bounds: rect, parts: [rect] };
	const parts: Rect[] = [];
	for (const l of logical) {
		const n = native.find((d) => d.id === l.id);
		const g = intersect(rect, l.bounds);
		if (!n || !g) continue;
		const s = l.scaleFactor;
		const x0 = n.bounds.x + Math.round((g.x - l.bounds.x) * s);
		const y0 = n.bounds.y + Math.round((g.y - l.bounds.y) * s);
		const x1 = n.bounds.x + Math.round((rectRight(g) - l.bounds.x) * s);
		const y1 = n.bounds.y + Math.round((rectBottom(g) - l.bounds.y) * s);
		parts.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
	}
	const bounds = union(parts);
	if (!bounds) throw new Error(`rect ${formatRect(rect)} is not on any display`);
	return { bounds, parts };
}

/**
 * Inverse of logicalToNative for a rect that starts on one monitor (used only to
 * feed Electrobun's built-in Screen.captureRegion, which takes logical coords).
 * The size is scaled by the origin monitor's factor and rounded.
 */
export function nativeToLogical(
	rect: Rect,
	logical: ElectrobunDisplay[],
	native: NativeDisplay[],
	platform: "darwin" | "win32" | string,
): Rect {
	if (platform !== "win32") return rect;
	const n = native.find(
		(d) =>
			rect.x >= d.bounds.x &&
			rect.x < rectRight(d.bounds) &&
			rect.y >= d.bounds.y &&
			rect.y < rectBottom(d.bounds),
	);
	const l = n && logical.find((d) => d.id === n.id);
	if (!n || !l) throw new Error(`rect ${formatRect(rect)} origin is not on any display`);
	const s = l.scaleFactor;
	return {
		x: l.bounds.x + (rect.x - n.bounds.x) / s,
		y: l.bounds.y + (rect.y - n.bounds.y) / s,
		width: Math.max(1, Math.round(rect.width / s)),
		height: Math.max(1, Math.round(rect.height / s)),
	};
}

/** Find two horizontally/vertically adjacent displays and a region straddling their shared edge. */
export function spanningRegion(
	displays: NativeDisplay[],
	width = 400,
	height = 120,
): Rect | null {
	for (const a of displays) {
		for (const b of displays) {
			if (a === b) continue;
			// b directly to the right of a
			if (Math.abs(rectRight(a.bounds) - b.bounds.x) < 1) {
				const y0 = Math.max(a.bounds.y, b.bounds.y);
				const y1 = Math.min(rectBottom(a.bounds), rectBottom(b.bounds));
				if (y1 > y0) {
					const h = Math.min(height, y1 - y0);
					const w = Math.min(width, 2 * Math.min(a.bounds.width, b.bounds.width));
					return { x: rectRight(a.bounds) - w / 2, y: Math.round(y0 + (y1 - y0 - h) / 2), width: w, height: h };
				}
			}
			// b directly below a
			if (Math.abs(rectBottom(a.bounds) - b.bounds.y) < 1) {
				const x0 = Math.max(a.bounds.x, b.bounds.x);
				const x1 = Math.min(rectRight(a.bounds), rectRight(b.bounds));
				if (x1 > x0) {
					const w = Math.min(width, x1 - x0);
					const h = Math.min(height, 2 * Math.min(a.bounds.height, b.bounds.height));
					return { x: Math.round(x0 + (x1 - x0 - w) / 2), y: rectBottom(a.bounds) - h / 2, width: w, height: h };
				}
			}
		}
	}
	return null;
}
