// PP-OCR text detection (DB, Differentiable Binarization) pre- and post-processing. Pure.
// Mirrors PaddleOCR's DetResizeForTest + NormalizeImage and DBPostProcess (box mode, "fast"
// score), with connected components standing in for cv2.findContours.
// Ported from spikes/inference/src/ocr/det.ts.

import type { Point, Quad } from "./image.ts";

/** ImageNet mean/std, applied in BGR channel order (PaddleOCR det config). */
export const DET_MEAN = [0.485, 0.456, 0.406] as const;
export const DET_STD = [0.229, 0.224, 0.225] as const;

export interface DetSizeOptions {
	/** Longest side cap. PaddleOCR allows 4000; screen regions rarely need more than 1920. */
	readonly maxSide: number;
	/** Upscale so the short side is at least this (helps tiny UI text). 0 = never upscale. */
	readonly minSide: number;
}

/** Network input size: scaled to the limits, each side rounded to a multiple of 32 (min 32). */
export function detInputSize(w: number, h: number, o: DetSizeOptions): { w: number; h: number; ratio: number } {
	let ratio = 1;
	if (o.minSide > 0 && Math.min(w, h) < o.minSide) ratio = o.minSide / Math.min(w, h);
	if (Math.max(w, h) * ratio > o.maxSide) ratio = o.maxSide / Math.max(w, h);
	const r32 = (v: number) => Math.max(32, Math.round((v * ratio) / 32) * 32);
	return { w: r32(w), h: r32(h), ratio };
}

export interface DbOptions {
	/** Pixel threshold on the probability map. */
	readonly thresh: number;
	/** Minimum mean probability inside a box. */
	readonly boxThresh: number;
	/** Box expansion. */
	readonly unclipRatio: number;
	/** Minimum short side, in map pixels. */
	readonly minSize: number;
	readonly maxCandidates: number;
}

export const DB_DEFAULTS: DbOptions = {
	thresh: 0.3,
	boxThresh: 0.6,
	unclipRatio: 1.5,
	minSize: 3,
	maxCandidates: 1000,
};

export interface DetBox {
	/** In source-image pixels. */
	readonly quad: Quad;
	/** Mean detector probability inside the box, 0..1. */
	readonly score: number;
}

const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Andrew's monotone chain convex hull. */
export function convexHull(pts: readonly Point[]): Point[] {
	const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	if (p.length < 3) return p;
	const half = (seq: Point[]): Point[] => {
		const out: Point[] = [];
		for (const q of seq) {
			while (out.length >= 2 && cross(out[out.length - 2] as Point, out[out.length - 1] as Point, q) <= 0) out.pop();
			out.push(q);
		}
		out.pop();
		return out;
	};
	return half(p).concat(half([...p].reverse()));
}

export interface RotRect {
	readonly cx: number;
	readonly cy: number;
	/** Along `angle`. */
	readonly w: number;
	readonly h: number;
	/** Radians, of the w axis. */
	readonly angle: number;
}

/** Minimum-area enclosing rectangle via rotating calipers over hull edges. */
export function minAreaRect(hull: readonly Point[]): RotRect {
	const first = hull[0];
	if (!first) return { cx: 0, cy: 0, w: 0, h: 0, angle: 0 };
	let best: RotRect = { cx: first[0], cy: first[1], w: 0, h: 0, angle: 0 };
	let bestArea = Number.POSITIVE_INFINITY;
	for (let i = 0; i < hull.length; i++) {
		const a = hull[i] as Point;
		const b = hull[(i + 1) % hull.length] as Point;
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		if (len === 0) continue;
		const ux = (b[0] - a[0]) / len;
		const uy = (b[1] - a[1]) / len;
		let minU = Number.POSITIVE_INFINITY;
		let maxU = Number.NEGATIVE_INFINITY;
		let minV = Number.POSITIVE_INFINITY;
		let maxV = Number.NEGATIVE_INFINITY;
		for (const p of hull) {
			const u = p[0] * ux + p[1] * uy;
			const v = -p[0] * uy + p[1] * ux;
			if (u < minU) minU = u;
			if (u > maxU) maxU = u;
			if (v < minV) minV = v;
			if (v > maxV) maxV = v;
		}
		const area = (maxU - minU) * (maxV - minV);
		if (area < bestArea - 1e-9) {
			bestArea = area;
			const cu = (minU + maxU) / 2;
			const cv = (minV + maxV) / 2;
			best = {
				cx: cu * ux - cv * uy,
				cy: cu * uy + cv * ux,
				w: maxU - minU,
				h: maxV - minV,
				angle: Math.atan2(uy, ux),
			};
		}
	}
	return best;
}

/** Normalise so w is the more horizontal axis (|angle| <= 45deg), then corners tl, tr, br, bl. */
export function rectCorners(r: RotRect): Quad {
	let { w, h, angle } = r;
	while (angle > Math.PI / 2) angle -= Math.PI;
	while (angle <= -Math.PI / 2) angle += Math.PI;
	if (Math.abs(angle) > Math.PI / 4) {
		[w, h] = [h, w];
		angle = angle > 0 ? angle - Math.PI / 2 : angle + Math.PI / 2;
	}
	const ux = Math.cos(angle);
	const uy = Math.sin(angle);
	const vx = -uy;
	const vy = ux;
	const hw = w / 2;
	const hh = h / 2;
	const c = (su: number, sv: number): Point => [r.cx + su * hw * ux + sv * hh * vx, r.cy + su * hw * uy + sv * hh * vy];
	return [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
}

/**
 * Expand a rectangle the way PaddleOCR's pyclipper offset does: distance = area * ratio /
 * perimeter on every side. For a rectangle the min-area rect of the offset polygon is exactly
 * (w + 2d, h + 2d).
 */
export function unclip(r: RotRect, ratio: number): RotRect {
	const per = 2 * (r.w + r.h);
	if (per === 0) return r;
	const d = (r.w * r.h * ratio) / per;
	return { ...r, w: r.w + 2 * d, h: r.h + 2 * d };
}

function pointInConvexQuad(x: number, y: number, q: Quad): boolean {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = q[i] as Point;
		const b = q[(i + 1) % 4] as Point;
		const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
		if (c !== 0) {
			const s = c > 0 ? 1 : -1;
			if (sign === 0) sign = s;
			else if (s !== sign) return false;
		}
	}
	return true;
}

/** Mean probability inside a quad (PaddleOCR "fast" box score). */
export function boxScore(prob: Float32Array, mw: number, mh: number, q: Quad): number {
	const xs = q.map((p) => p[0]);
	const ys = q.map((p) => p[1]);
	const x0 = Math.max(0, Math.floor(Math.min(...xs)));
	const x1 = Math.min(mw - 1, Math.ceil(Math.max(...xs)));
	const y0 = Math.max(0, Math.floor(Math.min(...ys)));
	const y1 = Math.min(mh - 1, Math.ceil(Math.max(...ys)));
	let sum = 0;
	let n = 0;
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			if (pointInConvexQuad(x, y, q)) {
				sum += prob[y * mw + x] as number;
				n++;
			}
		}
	}
	return n ? sum / n : 0;
}

/**
 * Connected components (4-connected) of `prob > thresh`. For each component returns the
 * leftmost and rightmost pixel of every row: the same convex hull as the whole component,
 * with far fewer points.
 */
export function components(prob: Float32Array, mw: number, mh: number, thresh: number): Point[][] {
	const seen = new Uint8Array(mw * mh);
	const out: Point[][] = [];
	const stack: number[] = [];
	for (let i = 0; i < mw * mh; i++) {
		if (seen[i] || (prob[i] as number) <= thresh) continue;
		const rowMin = new Map<number, number>();
		const rowMax = new Map<number, number>();
		stack.push(i);
		seen[i] = 1;
		const visit = (k: number) => {
			if (!seen[k] && (prob[k] as number) > thresh) {
				seen[k] = 1;
				stack.push(k);
			}
		};
		for (let j = stack.pop(); j !== undefined; j = stack.pop()) {
			const x = j % mw;
			const y = (j - x) / mw;
			const mn = rowMin.get(y);
			if (mn === undefined || x < mn) rowMin.set(y, x);
			const mx = rowMax.get(y);
			if (mx === undefined || x > mx) rowMax.set(y, x);
			if (x > 0) visit(j - 1);
			if (x < mw - 1) visit(j + 1);
			if (y > 0) visit(j - mw);
			if (y < mh - 1) visit(j + mw);
		}
		const pts: Point[] = [];
		for (const [y, x] of rowMin) {
			pts.push([x, y]);
			const mx = rowMax.get(y) ?? x;
			if (mx !== x) pts.push([mx, y]);
		}
		out.push(pts);
	}
	return out;
}

/**
 * DB post-process: probability map (mw x mh, the network's input size) to boxes in
 * source-image coordinates (srcW x srcH), in rough reading order (top to bottom).
 */
export function dbPostprocess(
	prob: Float32Array,
	mw: number,
	mh: number,
	srcW: number,
	srcH: number,
	o: DbOptions = DB_DEFAULTS,
): DetBox[] {
	const comps = components(prob, mw, mh, o.thresh).slice(0, o.maxCandidates);
	const sx = srcW / mw;
	const sy = srcH / mh;
	const boxes: DetBox[] = [];
	for (const pts of comps) {
		if (pts.length < 2) continue;
		const r = minAreaRect(convexHull(pts));
		if (Math.min(r.w, r.h) < o.minSize - 1) continue;
		// +1: pixel centres to pixel edges, so a 1 px wide component has width 1.
		const tight = { ...r, w: r.w + 1, h: r.h + 1 };
		// Paddle scores the tight rect, then unclips.
		const score = boxScore(prob, mw, mh, rectCorners(tight));
		if (score < o.boxThresh) continue;
		const u = unclip(tight, o.unclipRatio);
		if (Math.min(u.w, u.h) < o.minSize + 2) continue;
		const clampX = (v: number) => Math.min(Math.max(v * sx, 0), srcW);
		const clampY = (v: number) => Math.min(Math.max(v * sy, 0), srcH);
		const q = rectCorners(u).map(([x, y]) => [clampX(x), clampY(y)] as Point) as unknown as Quad;
		boxes.push({ quad: q, score });
	}
	return sortReadingOrder(boxes);
}

/** Top to bottom, then left to right for boxes on the same line (PaddleOCR `sorted_boxes`). */
export function sortReadingOrder(boxes: readonly DetBox[]): DetBox[] {
	const b = [...boxes].sort((p, q) => p.quad[0][1] - q.quad[0][1] || p.quad[0][0] - q.quad[0][0]);
	for (let i = 0; i < b.length - 1; i++) {
		for (let j = i; j >= 0; j--) {
			const cur = b[j] as DetBox;
			const nxt = b[j + 1] as DetBox;
			if (Math.abs(nxt.quad[0][1] - cur.quad[0][1]) < 10 && nxt.quad[0][0] < cur.quad[0][0]) {
				b[j] = nxt;
				b[j + 1] = cur;
			} else break;
		}
	}
	return b;
}
