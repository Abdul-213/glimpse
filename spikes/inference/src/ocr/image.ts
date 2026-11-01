// Pure image helpers. Images are RGBA8, row-major, like a canvas ImageData or a
// screen capture converted from BGRA.
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array; // length = width * height * 4
}

export type Point = [number, number];

/** Crop an axis-aligned region (clamped to the image). */
export function crop(img: RgbaImage, x: number, y: number, w: number, h: number): RgbaImage {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(img.width, Math.floor(x + w));
  const y1 = Math.min(img.height, Math.floor(y + h));
  const cw = Math.max(0, x1 - x0);
  const ch = Math.max(0, y1 - y0);
  const out = new Uint8Array(cw * ch * 4);
  for (let r = 0; r < ch; r++) {
    const s = ((y0 + r) * img.width + x0) * 4;
    out.set(img.data.subarray(s, s + cw * 4), r * cw * 4);
  }
  return { width: cw, height: ch, data: out };
}

/**
 * Bilinear resize into a float CHW tensor with per-channel normalisation, in one pass.
 * Channel order is BGR because PaddleOCR models were trained on cv2 (BGR) input with
 * the mean/std applied in that order.
 * `padTo` (>= dstW) right-pads with zeros (post-normalisation), as PaddleOCR rec does.
 */
export function resizeNormalizeBGR(
  img: RgbaImage,
  dstW: number,
  dstH: number,
  mean: [number, number, number],
  std: [number, number, number],
  padTo = dstW,
  out?: Float32Array,
  outOffset = 0,
): Float32Array {
  const plane = padTo * dstH;
  const t = out ?? new Float32Array(3 * plane);
  const sx = img.width / dstW;
  const sy = img.height / dstH;
  const src = img.data;
  const W = img.width;
  // scale = 1/(255*std), bias = -mean/std; written per BGR channel
  const sc = [1 / (255 * std[0]), 1 / (255 * std[1]), 1 / (255 * std[2])];
  const bi = [-mean[0] / std[0], -mean[1] / std[1], -mean[2] / std[2]];
  for (let y = 0; y < dstH; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    let y0 = Math.floor(fy);
    if (y0 > img.height - 1) y0 = img.height - 1;
    const y1 = Math.min(y0 + 1, img.height - 1);
    const wy = fy - y0;
    for (let x = 0; x < dstW; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      let x0 = Math.floor(fx);
      if (x0 > W - 1) x0 = W - 1;
      const x1 = Math.min(x0 + 1, W - 1);
      const wx = fx - x0;
      const a = (y0 * W + x0) * 4;
      const b = (y0 * W + x1) * 4;
      const c = (y1 * W + x0) * 4;
      const d = (y1 * W + x1) * 4;
      const o = outOffset + y * padTo + x;
      for (let ch = 0; ch < 3; ch++) {
        // ch 0 = B (src +2), 1 = G (+1), 2 = R (+0)
        const k = 2 - ch;
        const top = src[a + k]! + (src[b + k]! - src[a + k]!) * wx;
        const bot = src[c + k]! + (src[d + k]! - src[c + k]!) * wx;
        const v = top + (bot - top) * wy;
        t[o + ch * plane] = v * sc[ch]! + bi[ch]!;
      }
    }
  }
  return t;
}

/**
 * Sample a (possibly rotated) quad into an upright w x h RGBA image with bilinear
 * interpolation. `quad` is [tl, tr, br, bl] in source pixels.
 */
export function warpQuad(img: RgbaImage, quad: [Point, Point, Point, Point], w: number, h: number): RgbaImage {
  const [tl, tr, , bl] = quad;
  const ux = (tr[0] - tl[0]) / w;
  const uy = (tr[1] - tl[1]) / w;
  const vx = (bl[0] - tl[0]) / h;
  const vy = (bl[1] - tl[1]) / h;
  const out = new Uint8Array(w * h * 4);
  const W = img.width;
  const H = img.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = tl[0] + (x + 0.5) * ux + (y + 0.5) * vx - 0.5;
      const fy = tl[1] + (x + 0.5) * uy + (y + 0.5) * vy - 0.5;
      const x0 = Math.max(0, Math.min(W - 1, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)));
      const x1 = Math.min(x0 + 1, W - 1);
      const y1 = Math.min(y0 + 1, H - 1);
      const wx = Math.max(0, Math.min(1, fx - x0));
      const wy = Math.max(0, Math.min(1, fy - y0));
      const a = (y0 * W + x0) * 4;
      const b = (y0 * W + x1) * 4;
      const c = (y1 * W + x0) * 4;
      const d = (y1 * W + x1) * 4;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) {
        const top = img.data[a + k]! + (img.data[b + k]! - img.data[a + k]!) * wx;
        const bot = img.data[c + k]! + (img.data[d + k]! - img.data[c + k]!) * wx;
        out[o + k] = Math.round(top + (bot - top) * wy);
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** Rotate 90 degrees counter-clockwise (PaddleOCR does this for tall crops). */
export function rotate90ccw(img: RgbaImage): RgbaImage {
  const { width: w, height: h } = img;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const nx = y;
      const ny = w - 1 - x;
      const d = (ny * h + nx) * 4;
      out[d] = img.data[s]!;
      out[d + 1] = img.data[s + 1]!;
      out[d + 2] = img.data[s + 2]!;
      out[d + 3] = img.data[s + 3]!;
    }
  }
  return { width: h, height: w, data: out };
}
