// Renders app/test/fixtures/capture/live-scenario: a scripted Live recording for GLIM-58
// (`bun run harness live-session`). One 800 x 240 display (scale 1) showing a static "scene"
// with a subtitle strip at the bottom (the Live region: 0,150 800x90):
//
//   A static 2 s -> B (the subtitle changes) 2 s -> flicker A/B every 100 ms for 1 s
//   -> A static 3 s (back to a line already read) -> C static 2 s (a new line)
//
// Real text (Noto Sans JP), so `--ocr paddle` can read it. Not part of the build; the PNGs are
// committed. To re-render (needs @napi-rs/canvas and the GLIM-17 fonts, as
// packages/providers/test/fixtures/ocr/make-fixtures.mjs):
//   CANVAS=~/.cache/glimpse-fixture-tools/node_modules/@napi-rs/canvas/index.js bun app/scripts/make-live-fixtures.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LIVE_SCENARIO_LINES, LIVE_SCENARIO_DIR as out } from "../src/harness/live-scenario.ts";

interface Ctx2d {
	fillStyle: string;
	strokeStyle: string;
	lineWidth: number;
	lineJoin: string;
	font: string;
	textAlign: string;
	textBaseline: string;
	fillRect(x: number, y: number, w: number, h: number): void;
	fillText(t: string, x: number, y: number): void;
	strokeText(t: string, x: number, y: number): void;
	beginPath(): void;
	arc(x: number, y: number, r: number, a: number, b: number): void;
	fill(): void;
}
interface CanvasModule {
	createCanvas(w: number, h: number): { getContext(k: "2d"): Ctx2d; toBuffer(mime: "image/png"): Uint8Array };
	GlobalFonts: { registerFromPath(path: string, family: string): void };
}

const { createCanvas, GlobalFonts } = (await import(process.env["CANVAS"] ?? "@napi-rs/canvas")) as CanvasModule;
const FONTS = process.env["GLIM_FONT_DIR"] ?? join(homedir(), ".cache", "glim17", "fonts");
GlobalFonts.registerFromPath(join(FONTS, "NotoSansJP.ttf"), "Noto Sans JP");

const W = 800;
const H = 240;
mkdirSync(out, { recursive: true });

function frame(line: string): Uint8Array {
	const c = createCanvas(W, H);
	const g = c.getContext("2d");
	// The "video": a flat night scene (flat colours keep the PNGs small).
	g.fillStyle = "#1b2433";
	g.fillRect(0, 0, W, H);
	g.fillStyle = "#2c3a52";
	g.fillRect(0, 110, W, 130);
	g.fillStyle = "#e8d9a0";
	g.beginPath();
	g.arc(660, 50, 22, 0, Math.PI * 2);
	g.fill();
	g.fillStyle = "#121a26";
	g.fillRect(80, 60, 70, 50);
	g.fillRect(170, 40, 50, 70);
	// The subtitle: white with a dark outline, centred in the strip.
	g.font = '30px "Noto Sans JP"';
	g.textAlign = "center";
	g.textBaseline = "middle";
	g.lineJoin = "round";
	g.lineWidth = 6;
	g.strokeStyle = "#000000";
	g.strokeText(line, W / 2, 195);
	g.fillStyle = "#ffffff";
	g.fillText(line, W / 2, 195);
	return c.toBuffer("image/png");
}

for (const [key, line] of Object.entries(LIVE_SCENARIO_LINES)) writeFileSync(join(out, `${key}.png`), frame(line));

const frames: { file: string; holdMs: number }[] = [
	{ file: "a.png", holdMs: 2000 },
	{ file: "b.png", holdMs: 2000 },
];
for (let i = 0; i < 10; i++) frames.push({ file: i % 2 === 0 ? "a.png" : "b.png", holdMs: 100 });
frames.push({ file: "a.png", holdMs: 3000 }, { file: "c.png", holdMs: 2000 });

const manifest = {
	displays: [
		{
			id: 1,
			bounds: { x: 0, y: 0, width: W, height: H },
			scaleFactor: 1,
			isPrimary: true,
			pixelBounds: { x: 0, y: 0, width: W, height: H },
		},
	],
	frames,
	advance: "timed",
	end: "hold",
};
writeFileSync(join(out, "frames.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
console.log(`wrote ${out}`);
