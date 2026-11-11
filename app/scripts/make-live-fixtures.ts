// Renders app/test/fixtures/capture/live-scenario: a scripted Live recording for GLIM-58
// (`bun run harness live-session`). One 800 x 240 display (scale 1) showing a static "scene"
// with a subtitle strip at the bottom (the Live region: 0,150 800x90):
//
//   A static 2 s -> B (the subtitle changes) 2 s -> flicker A/B every 100 ms for 1 s
//   -> A static 3 s (back to a line already read) -> C static 2 s (a new line)
//
// and app/test/fixtures/capture/moving-video (GLIM-114, `--scenario moving-video`): the same
// layout over a "video" that changes every 125 ms everywhere (8 fps, a 6-frame loop of
// random 40 px colour cells), with burned-in subtitles:
//
//   A 3 s -> no subtitle 0.5 s -> B 3 s -> C 3 s (swapped directly) -> A again 2.5 s
//
// Real text (Noto Sans JP), so `--ocr paddle` can read it. Not part of the build; the PNGs are
// committed. To re-render (needs @napi-rs/canvas and the GLIM-17 fonts, as
// packages/providers/test/fixtures/ocr/make-fixtures.mjs):
//   CANVAS=~/.cache/glimpse-fixture-tools/node_modules/@napi-rs/canvas/index.js bun app/scripts/make-live-fixtures.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	LIVE_SCENARIO_LINES,
	MOVING_VIDEO_DIR,
	MOVING_VIDEO_TIMELINE,
	LIVE_SCENARIO_DIR as out,
} from "../src/harness/live-scenario.ts";

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

/** Deterministic PRNG (mulberry32), so re-rendering gives the same pixels. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** `video`: frame index of the moving background, or null for the static night scene. */
function frame(line: string, video: number | null = null): Uint8Array {
	const c = createCanvas(W, H);
	const g = c.getContext("2d");
	if (video === null) {
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
	} else {
		// A moving video: every 40 px cell takes a new mid-range colour each frame (never white,
		// so the subtitle fill stays the only white in the frame).
		const r = rng(1000 + video);
		const ch = () => 40 + Math.floor(r() * 170);
		for (let y = 0; y < H; y += 40) {
			for (let x = 0; x < W; x += 40) {
				g.fillStyle = `rgb(${ch()}, ${ch()}, ${ch()})`;
				g.fillRect(x, y, 40, 40);
			}
		}
	}
	if (!line) return c.toBuffer("image/png");
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

// GLIM-114: subtitles over a moving video.
const VIDEO_FRAMES = 6;
const VIDEO_STEP_MS = 125;
mkdirSync(MOVING_VIDEO_DIR, { recursive: true });
const videoFrames: { file: string; holdMs: number }[] = [];
let v = 0;
for (const { key, ms } of MOVING_VIDEO_TIMELINE) {
	const line = key === "none" ? "" : LIVE_SCENARIO_LINES[key];
	for (let t = 0; t < ms; t += VIDEO_STEP_MS, v++) {
		const file = `${key}-${v % VIDEO_FRAMES}.png`;
		if (!videoFrames.some((f) => f.file === file)) {
			writeFileSync(join(MOVING_VIDEO_DIR, file), frame(line, v % VIDEO_FRAMES));
		}
		videoFrames.push({ file, holdMs: VIDEO_STEP_MS });
	}
}
writeFileSync(
	join(MOVING_VIDEO_DIR, "frames.json"),
	`${JSON.stringify({ ...manifest, frames: videoFrames }, null, "\t")}\n`,
);
console.log(`wrote ${MOVING_VIDEO_DIR}`);
