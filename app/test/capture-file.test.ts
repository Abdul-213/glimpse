// File-based capture backend (GLIM-86) and the PNG codec.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { rect } from "@glimpse/core";
import { makeImage, pixelAt } from "@glimpse/core/testing";
import { createFileCaptureSource, FrameFolderError, parseManifest } from "../src/bun/services/capture/file.ts";
import { SAMPLE_FRAMES_DIR } from "../src/bun/services/capture/index.ts";
import { crc32, decodePng, encodePng, PngError } from "../src/bun/services/capture/png.ts";

const tmp = mkdtempSync(join(tmpdir(), "glimpse-capture-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Hand-rolled PNG with a chosen filter per row, to exercise the decoder's unfiltering. */
function pngWith(
	width: number,
	height: number,
	colorType: number,
	depth: number,
	rows: number[][],
	extra: [string, number[]][] = [],
): Uint8Array {
	const chunk = (type: string, data: Uint8Array) => {
		const out = new Uint8Array(12 + data.length);
		const v = new DataView(out.buffer);
		v.setUint32(0, data.length);
		for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
		out.set(data, 8);
		v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
		return out;
	};
	const ihdr = new Uint8Array(13);
	const v = new DataView(ihdr.buffer);
	v.setUint32(0, width);
	v.setUint32(4, height);
	ihdr[8] = depth;
	ihdr[9] = colorType;
	const raw = Uint8Array.from(rows.flat());
	const parts = [
		Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		...extra.map(([t, d]) => chunk(t, Uint8Array.from(d))),
		chunk("IDAT", new Uint8Array(deflateSync(raw))),
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

describe("PNG codec", () => {
	test("encode -> decode round-trips RGBA", () => {
		const img = makeImage(7, 5, (x, y) => [x * 30, y * 50, (x + y) * 10]);
		const back = decodePng(encodePng(img));
		expect([back.width, back.height]).toEqual([7, 5]);
		expect(back.data).toEqual(img.data);
	});

	test("RGB with Sub, Up, Average and Paeth filters", () => {
		// 2x4 RGB. Target pixels: row y = [(10y, 20, 30), (10y+5, 25, 35)].
		const rows = [
			[1, 0, 20, 30, 5, 5, 5], // Sub: second pixel = first + 5
			[2, 10, 0, 0, 10, 0, 0], // Up: +10 red over row 0
			[3, 15, 10, 15, 13, 10, 15], // Average
			[4, 10, 0, 0, 10, 0, 0], // Paeth
		];
		const img = decodePng(pngWith(2, 4, 2, 8, rows));
		expect(pixelAt(img, 0, 0)).toEqual([0, 20, 30]);
		expect(pixelAt(img, 1, 0)).toEqual([5, 25, 35]);
		expect(pixelAt(img, 0, 1)).toEqual([10, 20, 30]);
		expect(pixelAt(img, 1, 1)).toEqual([15, 25, 35]);
		// Average: a=0 for the first pixel, so 15 + (0 + 10 >> 1) = 20.
		expect(pixelAt(img, 0, 2)).toEqual([20, 20, 30]);
		expect(pixelAt(img, 0, 3)[0]).toBe(30);
		expect(img.data[3]).toBe(255);
	});

	test("palette with 2-bit indices and tRNS, and 8-bit greyscale", () => {
		const pal = decodePng(
			pngWith(
				4,
				1,
				3,
				2,
				[[0, 0b00011011]],
				[
					["PLTE", [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]],
					["tRNS", [255, 128]],
				],
			),
		);
		expect([0, 1, 2, 3].map((x) => pixelAt(pal, x, 0))).toEqual([
			[255, 0, 0],
			[0, 255, 0],
			[0, 0, 255],
			[9, 9, 9],
		]);
		expect(pal.data[7]).toBe(128);
		const grey = decodePng(pngWith(2, 1, 0, 8, [[0, 7, 200]]));
		expect(pixelAt(grey, 1, 0)).toEqual([200, 200, 200]);
	});

	test("rejects junk and unsupported variants", () => {
		expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(PngError);
		expect(() => decodePng(pngWith(1, 1, 2, 4, [[0, 0]]))).toThrow(PngError);
	});
});

describe("file-based capture backend", () => {
	test("the sample recording: two displays, mixed DPI, four frames", async () => {
		const src = createFileCaptureSource(SAMPLE_FRAMES_DIR);
		expect(src.backend).toBe("file");
		expect(src.frameCount).toBe(4);
		expect(src.displays().map((d) => [d.id, d.scaleFactor])).toEqual([
			[1, 2],
			[2, 1],
		]);
		// Window title bar (accent blue) on the 2x display: logical (25, 20) -> px (50, 40).
		const f = await src.capture(rect(20, 15, 160, 90));
		expect([f.width, f.height, f.scale]).toEqual([320, 180, 2]);
		expect(pixelAt(f, 10, 10)).toEqual([0, 102, 204]);
	});

	test("a rect across both sample displays is upsampled on the 1x side", async () => {
		const src = createFileCaptureSource(SAMPLE_FRAMES_DIR);
		const f = await src.capture(rect(190, 0, 150, 60));
		expect([f.width, f.height]).toEqual([300, 120]);
		expect(f.displayIds).toEqual([1, 2]);
		// Logical (215, 20) is inside the caption box on display 2 (px 415, 20): window colour.
		expect(pixelAt(f, 50, 40)).toEqual([245, 245, 240]);
	});

	test("Live over the sample: the repeated frame reads as unchanged", async () => {
		const src = createFileCaptureSource(SAMPLE_FRAMES_DIR);
		const s = await src.openSession(rect(0, 0, 360, 120), { fps: 4 });
		const seq = [];
		for (let i = 0; i < 5; i++) seq.push((await s.next()).sequence);
		expect(seq).toEqual([1, 2, 2, 3, 3]);
	});

	test("a folder without frames.json uses every PNG and one display", async () => {
		const dir = join(tmp, "plain");
		mkdirSync(dir);
		writeFileSync(join(dir, "b.png"), encodePng(makeImage(8, 4, () => [0, 0, 255])));
		writeFileSync(join(dir, "a.png"), encodePng(makeImage(8, 4, () => [255, 0, 0])));
		const src = createFileCaptureSource(dir);
		expect(src.displays()).toEqual([
			{ id: 1, bounds: rect(0, 0, 8, 4), workArea: rect(0, 0, 8, 4), scaleFactor: 1, isPrimary: true },
		]);
		const first = await src.capture(rect(0, 0, 2, 2));
		expect(pixelAt(first, 0, 0)).toEqual([255, 0, 0]);
		const single = createFileCaptureSource(join(dir, "b.png"));
		expect(single.frameCount).toBe(1);
	});

	test("frames of different sizes and bad manifests are clear errors", () => {
		const dir = join(tmp, "mixed");
		mkdirSync(dir);
		writeFileSync(join(dir, "1.png"), encodePng(makeImage(4, 4, () => [0, 0, 0])));
		writeFileSync(join(dir, "2.png"), encodePng(makeImage(5, 4, () => [0, 0, 0])));
		expect(() => createFileCaptureSource(dir)).toThrow(/frames must all be 4x4/);
		expect(() => createFileCaptureSource(join(tmp, "missing"))).toThrow(FrameFolderError);
		expect(() => parseManifest({ advance: "sometimes" })).toThrow(FrameFolderError);
		expect(() => parseManifest({ displays: [{ bounds: rect(0, 0, 1, 1) }, { bounds: rect(1, 0, 1, 1) }] })).toThrow(
			/pixelBounds is required/,
		);
		expect(parseManifest({ frames: ["a.png", { file: "b.png", holdMs: 20 }] }).frames).toEqual([
			{ file: "a.png" },
			{ file: "b.png", holdMs: 20 },
		]);
	});
});
