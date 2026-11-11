// Minimal PNG encoder (8-bit RGBA, no interlace, filter 0) on top of zlib.
// Enough to save spike captures; Glimpse itself would never write PNGs in the
// hot path.
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
	let c = 0xffffffff;
	for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
	return out;
}

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encode tightly packed top-down RGBA8 pixels as PNG. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new Error(`bad PNG size ${width}x${height}`);
	}
	if (rgba.length !== width * height * 4) {
		throw new Error(`pixel buffer is ${rgba.length} bytes, expected ${width * height * 4}`);
	}
	const ihdr = new Uint8Array(13);
	const v = new DataView(ihdr.buffer);
	v.setUint32(0, width);
	v.setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type RGBA
	ihdr[10] = 0; // deflate
	ihdr[11] = 0; // filter method
	ihdr[12] = 0; // no interlace

	const stride = width * 4;
	const raw = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0; // filter type None
		raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	}
	const idat = deflateSync(raw, { level: 6 });

	const parts = [PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(idat)), chunk("IEND", new Uint8Array(0))];
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

/** In-place BGRA -> RGBA swap, forcing alpha to 255 (GDI leaves it 0). */
export function bgraToRgbaOpaque(px: Uint8Array): Uint8Array {
	for (let i = 0; i + 3 < px.length; i += 4) {
		const b = px[i]!;
		px[i] = px[i + 2]!;
		px[i + 2] = b;
		px[i + 3] = 255;
	}
	return px;
}
