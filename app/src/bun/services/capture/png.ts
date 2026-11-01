// Minimal PNG codec for the file-based capture backend and the harness: decode
// screenshots into RGBA8, encode captures for inspection. Not on any hot path.
// Decodes non-interlaced 8- and 16-bit greyscale, RGB, palette (1-8 bit), grey+alpha
// and RGBA, which covers what screenshot tools write.
import { deflateSync, inflateSync } from "node:zlib";
import type { RgbaImage } from "@glimpse/core";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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
	for (let i = start; i < end; i++) c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export class PngError extends Error {
	override readonly name = "PngError";
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(file: Uint8Array): RgbaImage {
	if (file.length < 8 || SIGNATURE.some((b, i) => file[i] !== b)) throw new PngError("not a PNG file");
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	let pos = 8;
	let width = 0;
	let height = 0;
	let depth = 0;
	let colorType = -1;
	let palette: Uint8Array | null = null;
	let paletteAlpha: Uint8Array | null = null;
	const idat: Uint8Array[] = [];
	while (pos + 8 <= file.length) {
		const len = view.getUint32(pos);
		const type = String.fromCharCode(...file.subarray(pos + 4, pos + 8));
		const data = file.subarray(pos + 8, pos + 8 + len);
		if (data.length !== len) throw new PngError(`truncated ${type} chunk`);
		pos += 12 + len;
		if (type === "IHDR") {
			if (len < 13) throw new PngError("short IHDR");
			const ihdr = new DataView(data.buffer, data.byteOffset, data.byteLength);
			width = ihdr.getUint32(0);
			height = ihdr.getUint32(4);
			depth = data[8] ?? 0;
			colorType = data[9] ?? -1;
			if ((data[12] ?? 0) !== 0) throw new PngError("interlaced PNGs are not supported");
		} else if (type === "PLTE") {
			palette = data;
		} else if (type === "tRNS") {
			paletteAlpha = data;
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") {
			break;
		}
	}
	const channels = CHANNELS[colorType];
	if (!width || !height || channels === undefined) throw new PngError(`unsupported PNG (colour type ${colorType})`);
	if (colorType === 3 ? ![1, 2, 4, 8].includes(depth) : ![8, 16].includes(depth)) {
		throw new PngError(`unsupported bit depth ${depth} for colour type ${colorType}`);
	}
	if (colorType === 3 && !palette) throw new PngError("palette PNG without PLTE");

	const compressed = new Uint8Array(idat.reduce((s, c) => s + c.length, 0));
	let o = 0;
	for (const c of idat) {
		compressed.set(c, o);
		o += c.length;
	}
	const raw = new Uint8Array(inflateSync(compressed));
	const bitsPerPixel = channels * depth;
	const stride = Math.ceil((width * bitsPerPixel) / 8);
	const bpp = Math.max(1, bitsPerPixel >> 3); // filter unit in bytes
	if (raw.length < (stride + 1) * height) throw new PngError("image data too short");

	const rows = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const out = rows.subarray(y * stride, (y + 1) * stride);
		const prev = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null;
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? (out[i - bpp] ?? 0) : 0;
			const b = prev ? (prev[i] ?? 0) : 0;
			const c = prev && i >= bpp ? (prev[i - bpp] ?? 0) : 0;
			const x = line[i] ?? 0;
			let v: number;
			switch (filter) {
				case 0:
					v = x;
					break;
				case 1:
					v = x + a;
					break;
				case 2:
					v = x + b;
					break;
				case 3:
					v = x + ((a + b) >> 1);
					break;
				case 4: {
					const p = a + b - c;
					const pa = Math.abs(p - a);
					const pb = Math.abs(p - b);
					const pc = Math.abs(p - c);
					v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
					break;
				}
				default:
					throw new PngError(`bad filter type ${filter} on row ${y}`);
			}
			out[i] = v & 0xff;
		}
	}

	const img: RgbaImage = { width, height, data: new Uint8Array(width * height * 4) };
	const d = img.data;
	const sample = (row: Uint8Array, index: number): number => {
		// index-th sample of the row, scaled to 8 bits
		if (depth === 8) return row[index] ?? 0;
		if (depth === 16) return row[index * 2] ?? 0;
		const perByte = 8 / depth;
		const byte = row[Math.floor(index / perByte)] ?? 0;
		const shift = 8 - depth * ((index % perByte) + 1);
		return (byte >> shift) & ((1 << depth) - 1);
	};
	for (let y = 0; y < height; y++) {
		const row = rows.subarray(y * stride, (y + 1) * stride);
		for (let x = 0; x < width; x++) {
			const o4 = (y * width + x) * 4;
			if (colorType === 3) {
				const idx = sample(row, x);
				d[o4] = palette?.[idx * 3] ?? 0;
				d[o4 + 1] = palette?.[idx * 3 + 1] ?? 0;
				d[o4 + 2] = palette?.[idx * 3 + 2] ?? 0;
				d[o4 + 3] = paletteAlpha?.[idx] ?? 255;
				continue;
			}
			const s = x * channels;
			if (channels <= 2) {
				const g = sample(row, s);
				d[o4] = g;
				d[o4 + 1] = g;
				d[o4 + 2] = g;
				d[o4 + 3] = channels === 2 ? sample(row, s + 1) : 255;
			} else {
				d[o4] = sample(row, s);
				d[o4 + 1] = sample(row, s + 1);
				d[o4 + 2] = sample(row, s + 2);
				d[o4 + 3] = channels === 4 ? sample(row, s + 3) : 255;
			}
		}
	}
	return img;
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

/** RGBA8 -> PNG (filter 0, zlib level 6). */
export function encodePng(img: RgbaImage): Uint8Array {
	const { width, height, data } = img;
	if (data.length !== width * height * 4)
		throw new PngError(`buffer is ${data.length} bytes, expected ${width * height * 4}`);
	const ihdr = new Uint8Array(13);
	const v = new DataView(ihdr.buffer);
	v.setUint32(0, width);
	v.setUint32(4, height);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const stride = width * 4;
	const raw = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	const parts = [
		Uint8Array.from(SIGNATURE),
		chunk("IHDR", ihdr),
		chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 6 }))),
		chunk("IEND", new Uint8Array(0)),
	];
	const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}
