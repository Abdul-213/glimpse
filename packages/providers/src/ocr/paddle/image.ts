// Pixel helpers for PP-OCR pre-processing. Pure (no ORT, no I/O), so they are unit-tested on
// their own. Ported from spikes/inference/src/ocr/image.ts, extended to read capture pixels
// directly (BGRA/RGBA/gray, padded rows) instead of converting them to RGBA first.

import type { OcrImage } from "@glimpse/core";

/** `[x, y]` in image pixels. */
export type Point = readonly [number, number];
/** `[tl, tr, br, bl]`, clockwise from top-left. */
export type Quad = readonly [Point, Point, Point, Point];

/** A view over pixel bytes: any of the capture formats, with row padding. */
export interface Raster {
	readonly width: number;
	readonly height: number;
	/** Bytes per row. */
	readonly stride: number;
	/** Bytes per pixel. */
	readonly bpp: number;
	/** Byte offsets of R, G and B inside a pixel (all 0 for gray). */
	readonly r: number;
	readonly g: number;
	readonly b: number;
	readonly data: Uint8Array;
}

/** Wrap an `OcrImage` without copying. */
export function rasterOf(image: OcrImage): Raster {
	const { width, height, stride, data } = image;
	switch (image.format) {
		case "rgba8":
			return { width, height, stride, data, bpp: 4, r: 0, g: 1, b: 2 };
		case "bgra8":
			return { width, height, stride, data, bpp: 4, r: 2, g: 1, b: 0 };
		case "gray8":
			return { width, height, stride, data, bpp: 1, r: 0, g: 0, b: 0 };
	}
}

/** A tightly packed RGBA raster. */
export function rgbaRaster(width: number, height: number, data = new Uint8Array(width * height * 4)): Raster {
	return { width, height, stride: width * 4, bpp: 4, r: 0, g: 1, b: 2, data };
}

/**
 * Bilinear resize into a float CHW tensor with per-channel normalisation, in one pass.
 * Channel order is BGR: PaddleOCR models were trained on cv2 (BGR) input with mean/std in that
 * order. `mean`/`std` are given in BGR order too (as PaddleOCR's configs list them).
 * `padTo` (>= dstW) right-pads each row with zeros (after normalisation), as PaddleOCR rec does.
 */
export function resizeNormalizeBGR(
	img: Raster,
	dstW: number,
	dstH: number,
	mean: readonly [number, number, number],
	std: readonly [number, number, number],
	padTo = dstW,
	out?: Float32Array,
	outOffset = 0,
): Float32Array {
	const plane = padTo * dstH;
	const t = out ?? new Float32Array(3 * plane);
	const sx = img.width / dstW;
	const sy = img.height / dstH;
	const { data: src, stride, bpp } = img;
	const offs = [img.b, img.g, img.r] as const;
	const sc = [1 / (255 * std[0]), 1 / (255 * std[1]), 1 / (255 * std[2])] as const;
	const bi = [-mean[0] / std[0], -mean[1] / std[1], -mean[2] / std[2]] as const;
	const maxX = img.width - 1;
	const maxY = img.height - 1;
	// Column lookups are the same for every row: precompute them.
	const xa = new Int32Array(dstW);
	const xb = new Int32Array(dstW);
	const xw = new Float32Array(dstW);
	for (let x = 0; x < dstW; x++) {
		let fx = (x + 0.5) * sx - 0.5;
		if (fx < 0) fx = 0;
		let x0 = Math.floor(fx);
		if (x0 > maxX) x0 = maxX;
		xa[x] = x0 * bpp;
		xb[x] = Math.min(x0 + 1, maxX) * bpp;
		xw[x] = fx - x0;
	}
	for (let y = 0; y < dstH; y++) {
		let fy = (y + 0.5) * sy - 0.5;
		if (fy < 0) fy = 0;
		let y0 = Math.floor(fy);
		if (y0 > maxY) y0 = maxY;
		const row0 = y0 * stride;
		const row1 = Math.min(y0 + 1, maxY) * stride;
		const wy = fy - y0;
		const rowOut = outOffset + y * padTo;
		for (let x = 0; x < dstW; x++) {
			const a = row0 + (xa[x] as number);
			const b = row0 + (xb[x] as number);
			const c = row1 + (xa[x] as number);
			const d = row1 + (xb[x] as number);
			const wx = xw[x] as number;
			for (let ch = 0; ch < 3; ch++) {
				const k = offs[ch] as number;
				const pa = src[a + k] as number;
				const pc = src[c + k] as number;
				const top = pa + ((src[b + k] as number) - pa) * wx;
				const bot = pc + ((src[d + k] as number) - pc) * wx;
				t[rowOut + x + ch * plane] = (top + (bot - top) * wy) * (sc[ch] as number) + (bi[ch] as number);
			}
		}
	}
	return t;
}

/**
 * Sample a (possibly rotated) quad into an upright `w` x `h` RGBA raster with bilinear
 * interpolation.
 */
export function warpQuad(img: Raster, quad: Quad, w: number, h: number): Raster {
	const [tl, tr, , bl] = quad;
	const ux = (tr[0] - tl[0]) / w;
	const uy = (tr[1] - tl[1]) / w;
	const vx = (bl[0] - tl[0]) / h;
	const vy = (bl[1] - tl[1]) / h;
	const out = new Uint8Array(w * h * 4);
	const { width: W, height: H, data, stride, bpp } = img;
	const offs = [img.r, img.g, img.b] as const;
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
			const a = y0 * stride + x0 * bpp;
			const b = y0 * stride + x1 * bpp;
			const c = y1 * stride + x0 * bpp;
			const d = y1 * stride + x1 * bpp;
			const o = (y * w + x) * 4;
			for (let k = 0; k < 3; k++) {
				const off = offs[k] as number;
				const pa = data[a + off] as number;
				const pc = data[c + off] as number;
				const top = pa + ((data[b + off] as number) - pa) * wx;
				const bot = pc + ((data[d + off] as number) - pc) * wx;
				out[o + k] = Math.round(top + (bot - top) * wy);
			}
			out[o + 3] = 255;
		}
	}
	return rgbaRaster(w, h, out);
}

/** Rotate a packed RGBA raster 90 degrees counter-clockwise (PaddleOCR does this for tall crops). */
export function rotate90ccw(img: Raster): Raster {
	const { width: w, height: h, data, stride } = img;
	const out = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const s = y * stride + x * 4;
			const d = ((w - 1 - x) * h + y) * 4;
			out[d] = data[s] as number;
			out[d + 1] = data[s + 1] as number;
			out[d + 2] = data[s + 2] as number;
			out[d + 3] = data[s + 3] as number;
		}
	}
	return rgbaRaster(h, w, out);
}
