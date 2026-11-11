// Regenerates app/test/fixtures/capture/sample: a small recorded "desktop" for the
// file-based capture backend, the harness and tests (GLIM-86).
//
// Layout (mixed DPI on purpose): a 2x display (200 x 120 pt -> 400 x 240 px) with a 1x
// display (160 x 120 pt) to its right, both in one 560 x 240 px image per frame.
// Frames: a window with "text" bars; the second display's caption changes in frame 2,
// frame 3 repeats frame 2 (nothing changed), frame 4 changes the first display.
//
//   bun app/scripts/make-capture-fixtures.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { allocRgba, type RgbaImage } from "@glimpse/core";
import { encodePng } from "../src/bun/services/capture/png.ts";

const out = resolve(import.meta.dir, "../test/fixtures/capture/sample");
const W = 560;
const H = 240;

type Rgb = readonly [number, number, number];
const BG: Rgb = [32, 36, 44];
const WINDOW: Rgb = [245, 245, 240];
const INK: Rgb = [30, 30, 30];
const ACCENT: Rgb = [0, 102, 204];

function fill(img: RgbaImage, x: number, y: number, w: number, h: number, [r, g, b]: Rgb): void {
	for (let yy = Math.max(0, y); yy < Math.min(img.height, y + h); yy++) {
		for (let xx = Math.max(0, x); xx < Math.min(img.width, x + w); xx++) {
			const i = (yy * img.width + xx) * 4;
			img.data[i] = r;
			img.data[i + 1] = g;
			img.data[i + 2] = b;
			img.data[i + 3] = 255;
		}
	}
}

/** Bars standing in for lines of text: widths per line, in px. */
function text(img: RgbaImage, x: number, y: number, lines: readonly number[], lineH: number, color: Rgb): void {
	lines.forEach((w, i) => {
		fill(img, x, Math.round(y + i * lineH * 1.6), w, lineH, color);
	});
}

function frame(variant: { leftLines: number[]; rightLines: number[] }): RgbaImage {
	const img = allocRgba(W, H);
	fill(img, 0, 0, W, H, BG);
	// Display 1 (2x): pixels 0..400. A window with a title bar and paragraph.
	fill(img, 40, 30, 320, 180, WINDOW);
	fill(img, 40, 30, 320, 24, ACCENT);
	text(img, 64, 76, variant.leftLines, 12, INK);
	// Display 2 (1x): pixels 400..560, top 120 rows. A caption box.
	fill(img, 412, 16, 136, 88, WINDOW);
	text(img, 420, 28, variant.rightLines, 8, INK);
	return img;
}

const frames = [
	{ file: "0001.png", holdMs: 500, img: frame({ leftLines: [240, 200, 260, 120], rightLines: [110, 90, 100] }) },
	{ file: "0002.png", holdMs: 500, img: frame({ leftLines: [240, 200, 260, 120], rightLines: [60, 116, 80] }) },
	{ file: "0003.png", holdMs: 500, img: frame({ leftLines: [240, 200, 260, 120], rightLines: [60, 116, 80] }) },
	{ file: "0004.png", holdMs: 1000, img: frame({ leftLines: [180, 260, 90, 220], rightLines: [60, 116, 80] }) },
];

mkdirSync(out, { recursive: true });
for (const f of frames) writeFileSync(join(out, f.file), encodePng(f.img));
const manifest = {
	displays: [
		{
			id: 1,
			bounds: { x: 0, y: 0, width: 200, height: 120 },
			scaleFactor: 2,
			isPrimary: true,
			pixelBounds: { x: 0, y: 0, width: 400, height: 240 },
		},
		{
			id: 2,
			bounds: { x: 200, y: 0, width: 160, height: 120 },
			scaleFactor: 1,
			isPrimary: false,
			pixelBounds: { x: 400, y: 0, width: 160, height: 120 },
		},
	],
	frames: frames.map(({ file, holdMs }) => ({ file, holdMs })),
	advance: "per-grab",
	end: "hold",
};
writeFileSync(join(out, "frames.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
console.log(`wrote ${frames.length} frames + frames.json to ${out}`);
