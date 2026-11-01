import { describe, expect, test } from "bun:test";
import { boxScore, components, convexHull, dbPostprocess, detInputSize, minAreaRect, rectCorners, sortReadingOrder, unclip, type Box } from "../src/ocr/det";
import type { Point } from "../src/ocr/image";

/** Probability map with filled axis-aligned rectangles. */
function mapWith(w: number, h: number, rects: [number, number, number, number, number?][]): Float32Array {
  const m = new Float32Array(w * h);
  for (const [x, y, rw, rh, v = 0.9] of rects) for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) m[j * w + i] = v;
  return m;
}

describe("detInputSize", () => {
  test("rounds each side to a multiple of 32 without scaling when within limits", () => {
    expect(detInputSize(600, 200, { maxSide: 1920, minSide: 0 })).toEqual({ w: 608, h: 192, ratio: 1 });
    expect(detInputSize(1920, 1080, { maxSide: 1920, minSide: 0 })).toEqual({ w: 1920, h: 1088, ratio: 1 });
  });
  test("caps the long side", () => {
    const s = detInputSize(3840, 2160, { maxSide: 1920, minSide: 0 });
    expect(s.w).toBe(1920);
    expect(s.h).toBe(1088);
    expect(s.ratio).toBe(0.5);
  });
  test("upscales a small region to minSide, but never past maxSide", () => {
    expect(detInputSize(300, 100, { maxSide: 1920, minSide: 200 })).toEqual({ w: 608, h: 192, ratio: 2 });
    expect(detInputSize(1000, 10, { maxSide: 1920, minSide: 736 }).w).toBe(1920);
  });
  test("never returns less than 32", () => {
    expect(detInputSize(5, 5, { maxSide: 1920, minSide: 0 })).toEqual({ w: 32, h: 32, ratio: 1 });
  });
});

describe("geometry", () => {
  test("convexHull drops interior and collinear points", () => {
    const pts: Point[] = [[0, 0], [2, 0], [4, 0], [4, 3], [0, 3], [2, 1], [1, 2]];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(4);
    expect(hull).toContainEqual([0, 0]);
    expect(hull).toContainEqual([4, 3]);
  });

  test("minAreaRect of an axis-aligned rectangle", () => {
    const r = minAreaRect(convexHull([[10, 20], [50, 20], [50, 30], [10, 30]]));
    expect(r.cx).toBeCloseTo(30);
    expect(r.cy).toBeCloseTo(25);
    expect(Math.max(r.w, r.h)).toBeCloseTo(40);
    expect(Math.min(r.w, r.h)).toBeCloseTo(10);
  });

  test("minAreaRect finds a rotated rectangle", () => {
    const a = Math.PI / 6;
    const c = Math.cos(a), s = Math.sin(a);
    const corners: Point[] = [[0, 0], [40, 0], [40, 10], [0, 10]].map(([x, y]) => [100 + x! * c - y! * s, 100 + x! * s + y! * c]);
    const r = minAreaRect(convexHull(corners));
    expect(r.w * r.h).toBeCloseTo(400, 3);
    const q = rectCorners(r);
    // tl..tr runs along the 40px side at +30 degrees
    expect(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1])).toBeCloseTo(40, 3);
    expect(Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0])).toBeCloseTo(a, 3);
  });

  test("rectCorners orders tl, tr, br, bl for an upright box", () => {
    const q = rectCorners({ cx: 50, cy: 20, w: 100, h: 20, angle: 0 });
    expect(q).toEqual([[0, 10], [100, 10], [100, 30], [0, 30]]);
  });

  test("rectCorners swaps axes so a near-vertical angle still yields a horizontal width", () => {
    const q = rectCorners({ cx: 50, cy: 20, w: 20, h: 100, angle: Math.PI / 2 });
    expect(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1])).toBeCloseTo(100);
    expect(q[0][0]).toBeCloseTo(0);
    expect(q[0][1]).toBeCloseTo(10);
  });

  test("unclip grows each side by area*ratio/perimeter", () => {
    const u = unclip({ cx: 0, cy: 0, w: 100, h: 20, angle: 0 }, 1.5);
    const d = (100 * 20 * 1.5) / 240;
    expect(u.w).toBeCloseTo(100 + 2 * d);
    expect(u.h).toBeCloseTo(20 + 2 * d);
  });
});

describe("components and boxScore", () => {
  test("separates two blobs and returns row extremes", () => {
    const m = mapWith(20, 10, [[1, 1, 5, 3], [10, 5, 6, 2]]);
    const cs = components(m, 20, 10, 0.3);
    expect(cs).toHaveLength(2);
    expect(cs[0]).toContainEqual([1, 1]);
    expect(cs[0]).toContainEqual([5, 3]);
    expect(cs[0]!.length).toBe(6); // 3 rows x (min, max)
  });
  test("boxScore averages the probability inside the quad", () => {
    const m = mapWith(10, 10, [[0, 0, 10, 5, 1]]); // top half = 1, bottom = 0
    expect(boxScore(m, 10, 10, [[0, 0], [9, 0], [9, 9], [0, 9]])).toBeCloseTo(0.5);
    expect(boxScore(m, 10, 10, [[0, 0], [9, 0], [9, 4], [0, 4]])).toBeCloseTo(1);
  });
});

describe("dbPostprocess", () => {
  test("turns text-line blobs into boxes in source coordinates, in reading order", () => {
    // map is the network input (64x32); source image is twice as large
    const m = mapWith(64, 32, [[34, 4, 20, 6], [4, 4, 24, 6], [4, 20, 50, 6]]);
    const boxes = dbPostprocess(m, 64, 32, 128, 64);
    expect(boxes).toHaveLength(3);
    const [a, b, c] = boxes;
    // same line, left first
    expect(a!.quad[0][0]).toBeLessThan(b!.quad[0][0]);
    expect(c!.quad[0][1]).toBeGreaterThan(a!.quad[0][1]);
    // first box: 24x6 map px -> unclipped by d = 144*1.5/60 = 3.6, then x2 to source
    const w = a!.quad[1][0] - a!.quad[0][0];
    const h = a!.quad[3][1] - a!.quad[0][1];
    expect(w).toBeCloseTo((24 + 7.2) * 2, 0);
    expect(h).toBeCloseTo((6 + 7.2) * 2, 0);
    expect(a!.score).toBeCloseTo(0.9, 1);
  });

  test("drops low-confidence and tiny blobs", () => {
    const m = mapWith(64, 32, [[4, 4, 20, 6, 0.4], [40, 4, 1, 1, 0.95]]);
    expect(dbPostprocess(m, 64, 32, 64, 32)).toHaveLength(0);
  });

  test("clamps boxes to the image", () => {
    const m = mapWith(32, 32, [[0, 0, 20, 6]]);
    const [b] = dbPostprocess(m, 32, 32, 32, 32);
    for (const [x, y] of b!.quad) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
    }
  });
});

test("sortReadingOrder treats boxes within 10px vertically as one line", () => {
  const box = (x: number, y: number): Box => ({ quad: [[x, y], [x + 10, y], [x + 10, y + 5], [x, y + 5]], score: 1 });
  const out = sortReadingOrder([box(50, 0), box(0, 40), box(0, 5), box(100, 8)]);
  expect(out.map((b) => b.quad[0])).toEqual([[0, 5], [50, 0], [100, 8], [0, 40]]);
});
