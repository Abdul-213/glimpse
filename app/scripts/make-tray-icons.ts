// Draws the placeholder tray icons into assets/tray/ (32 x 32, shown at 16 pt):
// four corner ticks, like the Live pinned-region frame (DESIGN.md), around two text
// lines. Monochrome per DESIGN.md Shapes. Replace with designed art in GLIM-41.
//   bun scripts/make-tray-icons.ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const SIZE = 32;

function mask(): Uint8Array {
	const m = new Uint8Array(SIZE * SIZE);
	const fill = (x0: number, y0: number, w: number, h: number) => {
		for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) m[y * SIZE + x] = 255;
	};
	const lo = 3;
	const hi = SIZE - 3;
	const len = 9;
	const t = 3;
	// Corner ticks.
	fill(lo, lo, len, t);
	fill(lo, lo, t, len);
	fill(hi - len, lo, len, t);
	fill(hi - t, lo, t, len);
	fill(lo, hi - t, len, t);
	fill(lo, hi - len, t, len);
	fill(hi - len, hi - t, len, t);
	fill(hi - t, hi - len, t, len);
	// Two text lines.
	fill(10, 12, 12, t);
	fill(10, 18, 8, t);
	return m;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

export function encodePng(rgb: [number, number, number], alpha: Uint8Array): Uint8Array {
	const ihdr = new Uint8Array(13);
	const v = new DataView(ihdr.buffer);
	v.setUint32(0, SIZE);
	v.setUint32(4, SIZE);
	ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
	const raw = new Uint8Array(SIZE * (1 + SIZE * 4));
	for (let y = 0; y < SIZE; y++) {
		const row = y * (1 + SIZE * 4);
		for (let x = 0; x < SIZE; x++) {
			raw.set([...rgb, alpha[y * SIZE + x] ?? 0], row + 1 + x * 4);
		}
	}
	const parts = [
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", new Uint8Array()),
	];
	return Buffer.concat(parts);
}

if (import.meta.main) {
	const dir = join(import.meta.dir, "..", "assets", "tray");
	mkdirSync(dir, { recursive: true });
	const m = mask();
	// macOS template image: black + alpha, the system tints it.
	await Bun.write(join(dir, "tray-template.png"), encodePng([0, 0, 0], m));
	// Windows/Linux: light glyph for dark taskbars, dark glyph for light ones.
	await Bun.write(join(dir, "tray-light.png"), encodePng([0xf4, 0xf4, 0xf6], m));
	await Bun.write(join(dir, "tray-dark.png"), encodePng([0x1d, 0x1d, 0x1f], m));
	console.log(`wrote tray icons to ${dir}`);
}
