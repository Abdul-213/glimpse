// RGBA buffer helpers. The capture contract (both OSes):
//   tightly packed, top row first, 8-bit R,G,B,A, alpha forced to 255.
// That is what an ONNX preprocessing step (resize + normalise + HWC->CHW)
// consumes directly; see FINDINGS.md "Getting pixels to Bun".

export interface RgbaImage {
	width: number;
	height: number;
	/** width * height * 4 bytes. */
	data: Uint8Array;
}

export function allocRgba(width: number, height: number): RgbaImage {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new Error(`bad image size ${width}x${height}`);
	}
	return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Fill with opaque black (used for parts of a region that are off every display). */
export function fillOpaqueBlack(img: RgbaImage): void {
	const d = img.data;
	d.fill(0);
	for (let i = 3; i < d.length; i += 4) d[i] = 255;
}

/** In-place BGRA -> RGBA swap (reference implementation; native code does this while copying). */
export function bgraToRgbaInPlace(data: Uint8Array): void {
	for (let i = 0; i + 3 < data.length; i += 4) {
		const b = data[i]!;
		data[i] = data[i + 2]!;
		data[i + 2] = b;
	}
}

/** Copy a strided BGRA source into a sub-rect of an RGBA destination (reference implementation). */
export function blitBgra(
	src: Uint8Array,
	srcStride: number,
	dst: RgbaImage,
	dx: number,
	dy: number,
	w: number,
	h: number,
): void {
	const dstStride = dst.width * 4;
	for (let row = 0; row < h; row++) {
		let s = row * srcStride;
		let o = (dy + row) * dstStride + dx * 4;
		for (let col = 0; col < w; col++, s += 4, o += 4) {
			dst.data[o] = src[s + 2]!;
			dst.data[o + 1] = src[s + 1]!;
			dst.data[o + 2] = src[s]!;
			dst.data[o + 3] = 255;
		}
	}
}

export interface ImageStats {
	meanLuma: number;
	/** Fraction of pixels exactly equal to the first pixel (1.0 = flat image). */
	flatFraction: number;
	allOpaque: boolean;
	/** 32-bit FNV-1a over the bytes, for cheap "did it change" checks. */
	hash: number;
}

/**
 * Cheap sanity stats. A capture that silently failed (macOS without permission
 * returns wallpaper-only or black frames; a lost DXGI duplication returns
 * nothing new) usually shows up as flatFraction ~1 or an unchanged hash.
 */
export function imageStats(img: RgbaImage): ImageStats {
	const d = img.data;
	const n = img.width * img.height;
	let luma = 0;
	let flat = 0;
	let opaque = true;
	let hash = 0x811c9dc5;
	const r0 = d[0];
	const g0 = d[1];
	const b0 = d[2];
	for (let i = 0; i < d.length; i += 4) {
		const r = d[i]!;
		const g = d[i + 1]!;
		const b = d[i + 2]!;
		luma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
		if (r === r0 && g === g0 && b === b0) flat++;
		if (d[i + 3] !== 255) opaque = false;
		hash = Math.imul(hash ^ r, 0x01000193);
		hash = Math.imul(hash ^ g, 0x01000193);
		hash = Math.imul(hash ^ b, 0x01000193);
	}
	return {
		meanLuma: n ? luma / n : 0,
		flatFraction: n ? flat / n : 1,
		allOpaque: opaque,
		hash: hash >>> 0,
	};
}

/** Cheap change detector for the fixed-rate loop: FNV-1a over every `step`-th pixel. */
export function sampleHash(img: RgbaImage, step = 7): number {
	const d = img.data;
	let h = 0x811c9dc5;
	for (let i = 0; i < d.length; i += 4 * step) {
		h = Math.imul(h ^ d[i]!, 0x01000193);
		h = Math.imul(h ^ d[i + 1]!, 0x01000193);
		h = Math.imul(h ^ d[i + 2]!, 0x01000193);
	}
	return h >>> 0;
}

/**
 * Fraction of pixels whose max channel delta exceeds `threshold`. This is the
 * Live-mode "did the region change" test; measured here only to show its cost.
 */
export function diffFraction(a: RgbaImage, b: RgbaImage, threshold = 16): number {
	if (a.width !== b.width || a.height !== b.height) return 1;
	const x = a.data;
	const y = b.data;
	let changed = 0;
	for (let i = 0; i < x.length; i += 4) {
		const dr = Math.abs(x[i]! - y[i]!);
		const dg = Math.abs(x[i + 1]! - y[i + 1]!);
		const db = Math.abs(x[i + 2]! - y[i + 2]!);
		if (dr > threshold || dg > threshold || db > threshold) changed++;
	}
	return changed / (a.width * a.height);
}

/**
 * The ONNX hand-off, to prove the buffer shape is usable: RGBA8 HWC -> float32
 * CHW (RGB), (v/255 - mean)/std. PaddleOCR det uses ImageNet mean/std. Resizing
 * to the model's input size is model-specific and left to the ONNX spike.
 */
export function rgbaToChwFloat32(
	img: RgbaImage,
	mean: [number, number, number] = [0.485, 0.456, 0.406],
	std: [number, number, number] = [0.229, 0.224, 0.225],
	out: Float32Array = new Float32Array(img.width * img.height * 3),
): Float32Array {
	const plane = img.width * img.height;
	if (out.length < plane * 3) throw new Error("output tensor too small");
	const d = img.data;
	const s0 = 1 / (255 * std[0]);
	const s1 = 1 / (255 * std[1]);
	const s2 = 1 / (255 * std[2]);
	const m0 = mean[0] / std[0];
	const m1 = mean[1] / std[1];
	const m2 = mean[2] / std[2];
	for (let p = 0, i = 0; p < plane; p++, i += 4) {
		out[p] = d[i]! * s0 - m0;
		out[plane + p] = d[i + 1]! * s1 - m1;
		out[2 * plane + p] = d[i + 2]! * s2 - m2;
	}
	return out;
}
