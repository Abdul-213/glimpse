import { describe, expect, test } from "bun:test";
import { crop, resizeNormalizeBGR, rotate90ccw, warpQuad, type RgbaImage } from "../src/ocr/image";
import { bucketWidth, buildCharset, ctcDecode, cropQuad, recBatch, recWidth, visualToLogicalRtl } from "../src/ocr/rec";
import { stats } from "../src/stats";
import { desktopRecord } from "../scripts/fetch-models";

function solid(w: number, h: number, rgba: [number, number, number, number]): RgbaImage {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set(rgba, i * 4);
  return { width: w, height: h, data: d };
}
/** Image whose pixel (x,y) has R=x, G=y, B=0. */
function ramp(w: number, h: number): RgbaImage {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([x, y, 0, 255], (y * w + x) * 4);
  return { width: w, height: h, data: d };
}
const px = (img: RgbaImage, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe("charset and CTC", () => {
  test("buildCharset puts blank first and space last", () => {
    expect(buildCharset("a\nb\nc\n")).toEqual(["", "a", "b", "c", " "]);
    expect(buildCharset("a\r\nb")).toEqual(["", "a", "b", " "]);
  });

  test("ctcDecode collapses repeats and drops blanks", () => {
    const cs = ["", "h", "i", " "];
    // steps: h h blank i i blank i  -> "hii"
    const seq = [1, 1, 0, 2, 2, 0, 2];
    const C = cs.length;
    const probs = new Float32Array(seq.length * C);
    seq.forEach((c, t) => {
      probs.fill(0.05, t * C, (t + 1) * C);
      probs[t * C + c] = 0.85;
    });
    const r = ctcDecode(probs, seq.length, C, cs);
    expect(r.text).toBe("hii");
    expect(r.score).toBeCloseTo(0.85);
  });

  test("ctcDecode honours the batch offset", () => {
    const cs = ["", "x", "y"];
    const probs = new Float32Array([1, 0, 0, 0, 1, 0, /* item 2 */ 0, 0, 1, 1, 0, 0]);
    expect(ctcDecode(probs, 2, 3, cs, 0).text).toBe("x");
    expect(ctcDecode(probs, 2, 3, cs, 6).text).toBe("y");
  });

  test("empty sequence scores 0", () => {
    expect(ctcDecode(new Float32Array(6).fill(0).map((_, i) => (i % 3 === 0 ? 1 : 0)), 2, 3, ["", "a", "b"])).toEqual({ text: "", score: 0 });
  });
});

describe("rec sizing and batching", () => {
  test("recWidth keeps aspect at height 48, capped and floored", () => {
    expect(recWidth(200, 24, 3200)).toBe(400);
    expect(recWidth(10000, 24, 3200)).toBe(3200);
    expect(recWidth(1, 100, 3200)).toBe(8);
  });
  test("bucketWidth rounds up", () => {
    expect(bucketWidth(321, 64)).toBe(384);
    expect(bucketWidth(321, 1)).toBe(321);
  });
  test("recBatch pads narrower crops with zeros to the widest", () => {
    const { data, width } = recBatch([solid(100, 48, [255, 255, 255, 255]), solid(50, 48, [255, 255, 255, 255])], 3200);
    expect(width).toBe(100);
    const per = 3 * 48 * 100;
    // white -> (1 - 0.5)/0.5 = 1
    expect(data[0]).toBeCloseTo(1);
    expect(data[per + 49]).toBeCloseTo(1); // last real column of item 2
    expect(data[per + 50]).toBe(0); // padding
  });
});

describe("image helpers", () => {
  test("resizeNormalizeBGR emits BGR planes with mean/std applied", () => {
    const t = resizeNormalizeBGR(solid(4, 4, [255, 0, 0, 255]), 2, 2, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    expect(t.length).toBe(12);
    expect(t[0]).toBeCloseTo(-1); // B plane: 0 -> -1
    expect(t[8]).toBeCloseTo(1); // R plane: 255 -> 1
  });
  test("resizeNormalizeBGR identity size reproduces pixels", () => {
    const img = ramp(8, 4);
    const t = resizeNormalizeBGR(img, 8, 4, [0, 0, 0], [1, 1, 1]);
    // R plane (index 2) at (x=5,y=2) = 5/255
    expect(t[2 * 32 + 2 * 8 + 5]).toBeCloseTo(5 / 255);
  });
  test("crop clamps to the image", () => {
    const c = crop(ramp(10, 10), 8, 8, 5, 5);
    expect([c.width, c.height]).toEqual([2, 2]);
    expect(px(c, 0, 0)).toEqual([8, 8, 0, 255]);
  });
  test("warpQuad with an axis-aligned quad equals a crop", () => {
    const img = ramp(20, 20);
    const w = warpQuad(img, [[4, 6], [12, 6], [12, 10], [4, 10]], 8, 4);
    expect(px(w, 0, 0)).toEqual([4, 6, 0, 255]);
    expect(px(w, 7, 3)).toEqual([11, 9, 0, 255]);
  });
  test("rotate90ccw moves the top-right pixel to the top-left", () => {
    const r = rotate90ccw(ramp(3, 2));
    expect([r.width, r.height]).toEqual([2, 3]);
    expect(px(r, 0, 0)).toEqual([2, 0, 0, 255]);
  });
  test("cropQuad rotates tall crops", () => {
    const c = cropQuad(ramp(40, 40), [[0, 0], [10, 0], [10, 30], [0, 30]]);
    expect([c.width, c.height]).toEqual([30, 10]);
  });
});

describe("misc", () => {
  test("visualToLogicalRtl reverses Arabic but keeps digit runs", () => {
    expect(visualToLogicalRtl("جبا")).toBe("ابج");
    expect(visualToLogicalRtl("OK")).toBe("OK");
    expect(visualToLogicalRtl("ب 2024 ا")).toBe("ا 2024 ب");
  });
  test("stats percentiles", () => {
    expect(stats([5, 1, 3, 2, 4])).toEqual({ n: 5, p50: 3, p90: 5, min: 1, max: 5 });
  });
  test("desktopRecord keeps desktop records only", () => {
    expect(desktopRecord("")).toBe(true);
    expect(desktopRecord("env.appinfo.OS != 'Android'")).toBe(true);
    expect(desktopRecord("env.appinfo.OS == 'Android'")).toBe(false);
    expect(desktopRecord("env.channel == 'default' || env.channel == 'nightly'")).toBe(false);
  });
});
