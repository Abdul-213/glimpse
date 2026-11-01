// PP-OCR text recognition (SVTR/CTC) pre- and post-processing.
import { type Point, type RgbaImage, resizeNormalizeBGR, rotate90ccw, warpQuad } from "./image";

export const REC_HEIGHT = 48;
export const REC_MEAN: [number, number, number] = [0.5, 0.5, 0.5];
export const REC_STD: [number, number, number] = [0.5, 0.5, 0.5];

/** Class list as PaddleOCR builds it: index 0 = CTC blank, then the dict, then " " (use_space_char). */
export function buildCharset(dictText: string): string[] {
  const lines = dictText.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return ["", ...lines, " "];
}

export interface CtcResult {
  text: string;
  score: number; // mean max-probability over emitted characters
}

/**
 * Greedy CTC decode of one sequence: argmax per step, collapse repeats, drop blanks.
 * `logits` is [T, C] row-major (the PP-OCRv5 export already applies softmax).
 */
export function ctcDecode(probs: Float32Array, T: number, C: number, charset: string[], offset = 0): CtcResult {
  let prev = -1;
  let text = "";
  let sum = 0;
  let n = 0;
  for (let t = 0; t < T; t++) {
    const base = offset + t * C;
    let best = 0;
    let bestV = probs[base]!;
    for (let c = 1; c < C; c++) {
      const v = probs[base + c]!;
      if (v > bestV) {
        bestV = v;
        best = c;
      }
    }
    if (best !== 0 && best !== prev) {
      text += charset[best] ?? "";
      sum += bestV;
      n++;
    }
    prev = best;
  }
  return { text, score: n ? sum / n : 0 };
}

/**
 * The Arabic recogniser reads left-to-right, so it emits RTL text in visual order.
 * Reverse to logical order, keeping runs of LTR characters (digits, Latin) in their
 * original direction. Same idea as PaddleOCR's `pred_reverse` for Arabic.
 */
export function visualToLogicalRtl(s: string): string {
  const parts: string[] = [];
  let ltr = "";
  for (const ch of s) {
    if (/[0-9A-Za-z.:%/+-]/.test(ch)) ltr += ch;
    else {
      if (ltr) parts.push(ltr);
      ltr = "";
      parts.push(ch);
    }
  }
  if (ltr) parts.push(ltr);
  return parts.reverse().join("");
}

/** Target width for a crop at height 48, capped. */
export function recWidth(w: number, h: number, maxW: number): number {
  return Math.max(8, Math.min(maxW, Math.ceil((REC_HEIGHT * w) / Math.max(1, h))));
}

/** Upright crop of a detected quad; tall crops (h/w >= 1.5) are rotated like PaddleOCR. */
export function cropQuad(img: RgbaImage, q: [Point, Point, Point, Point]): RgbaImage {
  const w = Math.max(1, Math.round(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1])));
  const h = Math.max(1, Math.round(Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1])));
  const c = warpQuad(img, q, w, h);
  return h / w >= 1.5 ? rotate90ccw(c) : c;
}

/** Round a tensor width up to a multiple of `bucket` so ORT sees few distinct shapes. */
export function bucketWidth(w: number, bucket: number): number {
  return bucket > 1 ? Math.ceil(w / bucket) * bucket : w;
}

/**
 * Batch crops into one [N,3,48,W] tensor, right-padded with zeros to the widest
 * (then rounded up to `bucket`).
 */
export function recBatch(crops: RgbaImage[], maxW: number, bucket = 1): { data: Float32Array; width: number } {
  const widths = crops.map((c) => recWidth(c.width, c.height, maxW));
  const W = bucketWidth(Math.max(8, ...widths), bucket);
  const per = 3 * REC_HEIGHT * W;
  const data = new Float32Array(crops.length * per);
  crops.forEach((c, i) => resizeNormalizeBGR(c, widths[i]!, REC_HEIGHT, REC_MEAN, REC_STD, W, data, i * per));
  return { data, width: W };
}
