// RGBA8 buffer helpers shared by the capture backends (the file backend composes
// frames with these; native backends do the same work in C) and by tests.
import type { Rect } from "../geometry.ts";

/** Tightly packed RGBA8, top row first. */
export interface RgbaImage {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8Array;
}

export function allocRgba(width: number, height: number): RgbaImage {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new RangeError(`bad image size ${width}x${height}`);
	}
	return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Opaque black: what parts of a capture that are on no display look like. */
export function fillOpaqueBlack(img: RgbaImage): void {
	const d = img.data;
	d.fill(0);
	for (let i = 3; i < d.length; i += 4) d[i] = 255;
}

/**
 * Copy `src` (integer rect inside `from`) into `dest` (integer rect inside `to`),
 * resampling bilinearly when the sizes differ. Alpha is forced to 255. Source pixels
 * outside `from` read as black, so a rect hanging off an image edge doesn't throw.
 */
export function blitRgba(from: RgbaImage, src: Rect, to: RgbaImage, dest: Rect): void {
	const dw = dest.width;
	const dh = dest.height;
	if (dw <= 0 || dh <= 0 || src.width <= 0 || src.height <= 0) return;
	if (dest.x < 0 || dest.y < 0 || dest.x + dw > to.width || dest.y + dh > to.height) {
		throw new RangeError(`dest ${JSON.stringify(dest)} outside ${to.width}x${to.height}`);
	}
	const s = from.data;
	const o = to.data;
	const sw = from.width;
	const sh = from.height;
	const px = (x: number, y: number, c: number): number =>
		x < 0 || y < 0 || x >= sw || y >= sh ? 0 : (s[(y * sw + x) * 4 + c] ?? 0);

	if (src.width === dw && src.height === dh) {
		for (let y = 0; y < dh; y++) {
			let oi = ((dest.y + y) * to.width + dest.x) * 4;
			for (let x = 0; x < dw; x++, oi += 4) {
				const sx = src.x + x;
				const sy = src.y + y;
				o[oi] = px(sx, sy, 0);
				o[oi + 1] = px(sx, sy, 1);
				o[oi + 2] = px(sx, sy, 2);
				o[oi + 3] = 255;
			}
		}
		return;
	}
	// Bilinear, pixel centres aligned (the usual "half-pixel" convention).
	const fx = src.width / dw;
	const fy = src.height / dh;
	for (let y = 0; y < dh; y++) {
		const syf = Math.min(src.height - 1, Math.max(0, (y + 0.5) * fy - 0.5));
		const y0 = Math.floor(syf);
		const y1 = Math.min(src.height - 1, y0 + 1);
		const wy = syf - y0;
		let oi = ((dest.y + y) * to.width + dest.x) * 4;
		for (let x = 0; x < dw; x++, oi += 4) {
			const sxf = Math.min(src.width - 1, Math.max(0, (x + 0.5) * fx - 0.5));
			const x0 = Math.floor(sxf);
			const x1 = Math.min(src.width - 1, x0 + 1);
			const wx = sxf - x0;
			for (let c = 0; c < 3; c++) {
				const a = px(src.x + x0, src.y + y0, c);
				const b = px(src.x + x1, src.y + y0, c);
				const cc = px(src.x + x0, src.y + y1, c);
				const d = px(src.x + x1, src.y + y1, c);
				const top = a + (b - a) * wx;
				const bot = cc + (d - cc) * wx;
				o[oi + c] = Math.round(top + (bot - top) * wy);
			}
			o[oi + 3] = 255;
		}
	}
}

/** FNV-1a over every `step`-th pixel's RGB. Cheap "did it change" fingerprint for tests and the harness. */
export function rgbaHash(img: RgbaImage, step = 1): number {
	const d = img.data;
	let h = 0x811c9dc5;
	const stride = 4 * Math.max(1, Math.floor(step));
	for (let i = 0; i + 2 < d.length; i += stride) {
		h = Math.imul(h ^ (d[i] ?? 0), 0x01000193);
		h = Math.imul(h ^ (d[i + 1] ?? 0), 0x01000193);
		h = Math.imul(h ^ (d[i + 2] ?? 0), 0x01000193);
	}
	return h >>> 0;
}
