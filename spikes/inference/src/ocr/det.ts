// PP-OCR text detection (DB / Differentiable Binarization) pre- and post-processing.
// Mirrors PaddleOCR's DetResizeForTest + NormalizeImage and DBPostProcess (box mode,
// "fast" score), with connected components standing in for cv2.findContours.
import type { Point } from "./image";

export const DET_MEAN: [number, number, number] = [0.485, 0.456, 0.406];
export const DET_STD: [number, number, number] = [0.229, 0.224, 0.225];

export interface DetSizeOptions {
  /** Longest side cap (PaddleOCR max_side_limit is 4000; screenshots rarely need >1920). */
  maxSide: number;
  /** Upscale so the short side is at least this (helps tiny UI text). 0 = never upscale. */
  minSide: number;
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
  thresh: number; // pixel threshold on the probability map (0.3)
  boxThresh: number; // min mean probability inside a box (0.6)
  unclipRatio: number; // box expansion (1.5)
  minSize: number; // min short side in map pixels (3)
  maxCandidates: number; // 1000
}
export const DB_DEFAULTS: DbOptions = { thresh: 0.3, boxThresh: 0.6, unclipRatio: 1.5, minSize: 3, maxCandidates: 1000 };

export interface Box {
  /** [tl, tr, br, bl] in source-image pixels, clockwise from top-left. */
  quad: [Point, Point, Point, Point];
  score: number;
}

/** Andrew's monotone chain. Returns hull counter-clockwise (in y-down coords: clockwise on screen). */
export function convexHull(pts: Point[]): Point[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Point[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export interface RotRect {
  cx: number;
  cy: number;
  w: number; // along angle
  h: number;
  angle: number; // radians, of the w axis
}

/** Minimum-area enclosing rectangle via rotating calipers over hull edges. */
export function minAreaRect(hull: Point[]): RotRect {
  if (hull.length === 0) return { cx: 0, cy: 0, w: 0, h: 0, angle: 0 };
  if (hull.length === 1) return { cx: hull[0]![0], cy: hull[0]![1], w: 0, h: 0, angle: 0 };
  let best: RotRect | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
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
      best = { cx: cu * ux - cv * uy, cy: cu * uy + cv * ux, w: maxU - minU, h: maxV - minV, angle: Math.atan2(uy, ux) };
    }
  }
  return best ?? { cx: hull[0]![0], cy: hull[0]![1], w: 0, h: 0, angle: 0 };
}

/** Normalise so w is the more horizontal axis (|angle| <= 45deg), then corners tl,tr,br,bl. */
export function rectCorners(r: RotRect): [Point, Point, Point, Point] {
  let { w, h, angle } = r;
  // bring angle into (-pi/2, pi/2]
  while (angle > Math.PI / 2) angle -= Math.PI;
  while (angle <= -Math.PI / 2) angle += Math.PI;
  if (Math.abs(angle) > Math.PI / 4) {
    // swap axes so the "width" axis is closest to horizontal
    [w, h] = [h, w];
    angle = angle > 0 ? angle - Math.PI / 2 : angle + Math.PI / 2;
  }
  const ux = Math.cos(angle), uy = Math.sin(angle);
  const vx = -uy, vy = ux; // perpendicular, pointing "down" on screen
  const hw = w / 2, hh = h / 2;
  const c = (su: number, sv: number): Point => [r.cx + su * hw * ux + sv * hh * vx, r.cy + su * hw * uy + sv * hh * vy];
  return [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
}

/**
 * Expand a rectangle the way PaddleOCR's pyclipper offset does: distance =
 * area * ratio / perimeter on every side. For a rectangle the min-area rect of the
 * rounded offset polygon is exactly (w + 2d, h + 2d).
 */
export function unclip(r: RotRect, ratio: number): RotRect {
  const per = 2 * (r.w + r.h);
  if (per === 0) return r;
  const d = (r.w * r.h * ratio) / per;
  return { ...r, w: r.w + 2 * d, h: r.h + 2 * d };
}

function pointInConvexQuad(x: number, y: number, q: [Point, Point, Point, Point]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
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
export function boxScore(prob: Float32Array, mw: number, mh: number, q: [Point, Point, Point, Point]): number {
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
        sum += prob[y * mw + x]!;
        n++;
      }
    }
  }
  return n ? sum / n : 0;
}

/**
 * Connected components (4-connected) of `prob > thresh`. For each component returns
 * the per-row leftmost/rightmost pixels, which have the same convex hull as the
 * whole component but far fewer points.
 */
export function components(prob: Float32Array, mw: number, mh: number, thresh: number): Point[][] {
  const seen = new Uint8Array(mw * mh);
  const out: Point[][] = [];
  const stack: number[] = [];
  for (let i = 0; i < mw * mh; i++) {
    if (seen[i] || prob[i]! <= thresh) continue;
    const rowMin = new Map<number, number>();
    const rowMax = new Map<number, number>();
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % mw;
      const y = (j - x) / mw;
      const mn = rowMin.get(y);
      if (mn === undefined || x < mn) rowMin.set(y, x);
      const mx = rowMax.get(y);
      if (mx === undefined || x > mx) rowMax.set(y, x);
      if (x > 0 && !seen[j - 1] && prob[j - 1]! > thresh) { seen[j - 1] = 1; stack.push(j - 1); }
      if (x < mw - 1 && !seen[j + 1] && prob[j + 1]! > thresh) { seen[j + 1] = 1; stack.push(j + 1); }
      if (y > 0 && !seen[j - mw] && prob[j - mw]! > thresh) { seen[j - mw] = 1; stack.push(j - mw); }
      if (y < mh - 1 && !seen[j + mw] && prob[j + mw]! > thresh) { seen[j + mw] = 1; stack.push(j + mw); }
    }
    const pts: Point[] = [];
    for (const [y, x] of rowMin) {
      pts.push([x, y]);
      const mx = rowMax.get(y)!;
      if (mx !== x) pts.push([mx, y]);
    }
    out.push(pts);
  }
  return out;
}

/**
 * DB post-process: probability map (mw x mh, the network's input size) -> boxes in
 * source-image coordinates (srcW x srcH).
 */
export function dbPostprocess(prob: Float32Array, mw: number, mh: number, srcW: number, srcH: number, o: DbOptions = DB_DEFAULTS): Box[] {
  const comps = components(prob, mw, mh, o.thresh).slice(0, o.maxCandidates);
  const sx = srcW / mw;
  const sy = srcH / mh;
  const boxes: Box[] = [];
  for (const pts of comps) {
    if (pts.length < 2) continue;
    const r = minAreaRect(convexHull(pts));
    if (Math.min(r.w, r.h) < o.minSize - 1) continue;
    // Paddle measures score on the tight rect, then unclips.
    const score = boxScore(prob, mw, mh, rectCorners({ ...r, w: r.w + 1, h: r.h + 1 }));
    if (score < o.boxThresh) continue;
    // +1: pixel centres -> pixel edges, so a 1px-wide component has width 1
    const u = unclip({ ...r, w: r.w + 1, h: r.h + 1 }, o.unclipRatio);
    if (Math.min(u.w, u.h) < o.minSize + 2) continue;
    const q = rectCorners(u).map(([x, y]) => [
      Math.min(Math.max(x * sx, 0), srcW),
      Math.min(Math.max(y * sy, 0), srcH),
    ]) as [Point, Point, Point, Point];
    boxes.push({ quad: q, score });
  }
  return sortReadingOrder(boxes);
}

/** Top-to-bottom, then left-to-right for boxes on the same line (PaddleOCR sorted_boxes). */
export function sortReadingOrder(boxes: Box[]): Box[] {
  const b = [...boxes].sort((p, q) => p.quad[0][1] - q.quad[0][1] || p.quad[0][0] - q.quad[0][0]);
  for (let i = 0; i < b.length - 1; i++) {
    for (let j = i; j >= 0; j--) {
      const cur = b[j]!;
      const nxt = b[j + 1]!;
      if (Math.abs(nxt.quad[0][1] - cur.quad[0][1]) < 10 && nxt.quad[0][0] < cur.quad[0][0]) {
        b[j] = nxt;
        b[j + 1] = cur;
      } else break;
    }
  }
  return b;
}
