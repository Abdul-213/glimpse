// Lossless PNG from a raw capture buffer, for Cloud Vision uploads (GLIM-22 "Privacy"):
// the cropped region only, re-encoded from pixels, so the file has no metadata at all
// (no text chunks, no colour profile, no timestamps). RGB for colour input (screen pixels
// are opaque, so alpha only costs bytes), grey for `gray8`.

import { deflateSync } from "node:zlib";
import type { OcrImage } from "@glimpse/core";

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
	let c = crc;
	for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
	return c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
	return out;
}

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encode an `OcrImage` (rgba8, bgra8 or gray8, any stride) as an 8-bit PNG. */
export function encodePng(image: OcrImage, level = 6): Uint8Array {
	const { width, height, stride, format, data } = image;
	const grey = format === "gray8";
	const channels = grey ? 1 : 3;
	const rowBytes = width * channels;
	const raw = new Uint8Array((rowBytes + 1) * height);
	const [r, b] = format === "bgra8" ? [2, 0] : [0, 2];
	for (let y = 0; y < height; y++) {
		const dst = y * (rowBytes + 1);
		raw[dst] = 0; // filter: none (deflate does well enough on screen content)
		const src = y * stride;
		if (grey) {
			raw.set(data.subarray(src, src + width), dst + 1);
			continue;
		}
		for (let x = 0, s = src, d = dst + 1; x < width; x++, s += 4, d += 3) {
			raw[d] = data[s + r] as number;
			raw[d + 1] = data[s + 1] as number;
			raw[d + 2] = data[s + b] as number;
		}
	}
	const ihdr = new Uint8Array(13);
	const h = new DataView(ihdr.buffer);
	h.setUint32(0, width);
	h.setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = grey ? 0 : 2; // colour type: grey / RGB
	ihdr[10] = 0; // deflate
	ihdr[11] = 0; // adaptive filtering
	ihdr[12] = 0; // no interlace
	const idat = new Uint8Array(deflateSync(raw, { level }));
	const parts = [SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let pos = 0;
	for (const p of parts) {
		out.set(p, pos);
		pos += p.length;
	}
	return out;
}

/** Base64 of the bytes (Vision's `image.content`). */
export const toBase64 = (bytes: Uint8Array): string =>
	Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
