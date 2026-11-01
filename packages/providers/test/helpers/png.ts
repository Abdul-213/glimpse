// Minimal PNG decoder for test fixtures (8-bit RGB/RGBA/gray, non-interlaced), so tests need
// no image dependency. The app never decodes PNGs: capture hands over raw pixels.

import { inflateSync } from "node:zlib";
import type { OcrImage } from "@glimpse/core";

export function decodePng(bytes: Uint8Array): OcrImage {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = 8;
	let width = 0;
	let height = 0;
	let colorType = 0;
	const idat: Uint8Array[] = [];
	while (pos < bytes.length) {
		const len = view.getUint32(pos);
		const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
		const body = bytes.subarray(pos + 8, pos + 8 + len);
		if (type === "IHDR") {
			const h = new DataView(body.buffer, body.byteOffset, body.byteLength);
			width = h.getUint32(0);
			height = h.getUint32(4);
			if (body[8] !== 8 || body[12] !== 0) throw new Error("only 8-bit non-interlaced PNGs");
			colorType = body[9] ?? 0;
		} else if (type === "IDAT") idat.push(body);
		else if (type === "IEND") break;
		pos += 12 + len;
	}
	const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
	if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const px = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)] ?? 0;
		const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const row = y * stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? (px[row + x - channels] as number) : 0;
			const b = y > 0 ? (px[row - stride + x] as number) : 0;
			const c = x >= channels && y > 0 ? (px[row - stride + x - channels] as number) : 0;
			let pred = 0;
			if (filter === 1) pred = a;
			else if (filter === 2) pred = b;
			else if (filter === 3) pred = (a + b) >> 1;
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			px[row + x] = ((src[x] as number) + pred) & 0xff;
		}
	}
	if (channels === 4) return { width, height, stride, format: "rgba8", data: px };
	if (channels === 1) return { width, height, stride, format: "gray8", data: px };
	const rgba = new Uint8Array(width * height * 4);
	for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
		rgba[j] = px[i] as number;
		rgba[j + 1] = px[i + 1] as number;
		rgba[j + 2] = px[i + 2] as number;
		rgba[j + 3] = 255;
	}
	return { width, height, stride: width * 4, format: "rgba8", data: rgba };
}

export async function loadPng(path: string): Promise<OcrImage> {
	return decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

/** The same pixels as BGRA with padded rows, like a DXGI/ScreenCaptureKit frame. */
export function toPaddedBgra(img: OcrImage, pad = 16): OcrImage {
	if (img.format !== "rgba8") throw new Error("rgba8 only");
	const stride = img.width * 4 + pad;
	const data = new Uint8Array(stride * img.height);
	for (let y = 0; y < img.height; y++) {
		for (let x = 0; x < img.width; x++) {
			const s = y * img.stride + x * 4;
			const d = y * stride + x * 4;
			data[d] = img.data[s + 2] as number;
			data[d + 1] = img.data[s + 1] as number;
			data[d + 2] = img.data[s] as number;
			data[d + 3] = img.data[s + 3] as number;
		}
	}
	return { width: img.width, height: img.height, stride, format: "bgra8", data };
}
