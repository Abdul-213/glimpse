// Renders the GLIM-56 layout fixtures (vertical Japanese, two columns, a menu + dialogue) with
// @napi-rs/canvas and the Noto fonts the GLIM-17 spike cached (spikes/inference/scripts/make-samples.ts).
// Not part of the build; the PNGs are committed. To re-render:
//   (cd ~/.cache/glimpse-fixture-tools && bun add @napi-rs/canvas@1.1.0)
//   CANVAS=~/.cache/glimpse-fixture-tools/node_modules/@napi-rs/canvas/index.js bun make-fixtures.mjs
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const { createCanvas, GlobalFonts } = await import(process.env.CANVAS ?? "@napi-rs/canvas");
const FONTS = process.env.GLIM_FONT_DIR ?? join(homedir(), ".cache", "glim17", "fonts");
GlobalFonts.registerFromPath(join(FONTS, "NotoSansJP.ttf"), "Noto Sans JP");
GlobalFonts.registerFromPath(join(FONTS, "NotoSans.ttf"), "Noto Sans");
const out = (name, c) => writeFileSync(join(import.meta.dir, name), c.toBuffer("image/png"));

// Vertical Japanese: three columns read top to bottom, right to left.
{
	const c = createCanvas(240, 420);
	const g = c.getContext("2d");
	g.fillStyle = "#fff";
	g.fillRect(0, 0, 240, 420);
	g.fillStyle = "#111";
	g.font = '26px "Noto Sans JP"';
	g.textBaseline = "top";
	const cols = ["吾輩は猫である", "名前はまだ無い", "どこで生れたか"];
	cols.forEach((col, i) => {
		const x = 180 - i * 60;
		for (const [k, ch] of [...col].entries()) g.fillText(ch, x, 20 + k * 34);
	});
	out("vertical-ja.png", c);
}

// Two columns of wrapped English text plus a full-width heading.
{
	const c = createCanvas(900, 360);
	const g = c.getContext("2d");
	g.fillStyle = "#fff";
	g.fillRect(0, 0, 900, 360);
	g.fillStyle = "#111";
	g.textBaseline = "top";
	g.font = '30px "Noto Sans"';
	g.fillText("Release notes", 30, 20);
	g.font = '20px "Noto Sans"';
	const left = [
		"The new version improves startup",
		"time and fixes a crash that could",
		"happen when the window was closed.",
	];
	const right = ["Known issues: the tray icon may", "not update until the next restart", "on some systems."];
	for (const [i, t] of left.entries()) g.fillText(t, 30, 90 + i * 28);
	for (const [i, t] of right.entries()) g.fillText(t, 480, 90 + i * 28);
	g.fillText("Settings", 30, 260);
	g.fillText("Help", 30, 300);
	out("columns-en.png", c);
}

// GLIM-152: comic pages. Speech bubbles (white ellipses with a tail) inside panel borders, the
// text centred or top-aligned in its bubble the way letterers set it. The grouping tests check
// one block per bubble, in the page's reading order. `ONLY=comic` renders just these two.
function bubble(g, cx, cy, rx, ry, tail) {
	g.save();
	g.fillStyle = "#fff";
	g.strokeStyle = "#111";
	g.lineWidth = 3;
	if (tail) {
		g.beginPath();
		g.moveTo(tail[0], tail[1]);
		g.lineTo(tail[2], tail[3]);
		g.lineTo(tail[4], tail[5]);
		g.closePath();
		g.fill();
		g.stroke();
	}
	g.beginPath();
	g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
	g.fill();
	g.stroke();
	g.restore();
}
function panels(g, w, h, rects) {
	g.fillStyle = "#fff";
	g.fillRect(0, 0, w, h);
	g.strokeStyle = "#111";
	g.lineWidth = 4;
	for (const [x, y, pw, ph] of rects) g.strokeRect(x, y, pw, ph);
	// A little hatching so the panels aren't empty (line art the detector must ignore).
	g.lineWidth = 1.5;
	for (const [x, y, , ph] of rects) {
		for (let i = 0; i < 6; i++) {
			g.beginPath();
			g.moveTo(x + 12 + i * 9, y + ph - 14);
			g.lineTo(x + 40 + i * 9, y + ph - 60);
			g.stroke();
		}
	}
}
/** Vertical columns, right to left from `x0`; `align` "top" (from `top`) or "centre" (around `cy`). */
function verticalText(g, cols, x0, top, pitch, colPitch, align, cy) {
	g.fillStyle = "#111";
	g.textBaseline = "top";
	cols.forEach((col, i) => {
		const chars = [...col];
		const y0 = align === "centre" ? cy - (chars.length * pitch) / 2 : top;
		for (const [k, ch] of chars.entries()) g.fillText(ch, x0 - i * colPitch, y0 + k * pitch);
	});
}
function centredLines(g, lines, cx, cy, pitch) {
	g.fillStyle = "#111";
	g.textBaseline = "middle";
	g.textAlign = "center";
	const y0 = cy - ((lines.length - 1) * pitch) / 2;
	for (const [i, t] of lines.entries()) g.fillText(t, cx, y0 + i * pitch);
	g.textAlign = "left";
}
function caption(g, x, y, w, h, text) {
	g.fillStyle = "#fff";
	g.fillRect(x, y, w, h);
	g.strokeStyle = "#111";
	g.lineWidth = 2;
	g.strokeRect(x, y, w, h);
	g.fillStyle = "#111";
	g.textBaseline = "top";
	g.fillText(text, x + 14, y + 8);
}

// Manga: three panels, vertical Japanese bubbles, read top-right first and panels right to
// left, plus one horizontal narration caption. Expected order: A1, A2, B, C caption, C bubble.
{
	const c = createCanvas(640, 720);
	const g = c.getContext("2d");
	panels(g, 640, 720, [
		[20, 20, 600, 320],
		[330, 360, 290, 340],
		[20, 360, 290, 340],
	]);
	g.font = '24px "Noto Sans JP"';
	// A1 (top right): columns of different lengths, top-aligned, a short middle column.
	bubble(g, 500, 160, 88, 120, [470, 270, 455, 320, 505, 274]);
	verticalText(g, ["ちょっと待って", "今の音", "聞こえた？"], 528, 64, 28, 36, "top");
	// A2 (top left, lower): columns centred in the bubble.
	bubble(g, 220, 190, 80, 110, [250, 292, 280, 330, 285, 280]);
	verticalText(g, ["何も", "聞こえない", "けど"], 248, 0, 28, 36, "centre", 190);
	// B (bottom right panel).
	bubble(g, 470, 520, 78, 105, [440, 618, 420, 660, 470, 622]);
	verticalText(g, ["じゃあ", "あれは何？"], 488, 448, 28, 36, "top");
	// C (bottom left panel): a horizontal narration box, then a bubble.
	g.font = '20px "Noto Sans JP"';
	caption(g, 36, 376, 150, 40, "その夜、森で");
	g.font = '24px "Noto Sans JP"';
	bubble(g, 170, 560, 80, 105, [130, 652, 100, 690, 160, 660]);
	verticalText(g, ["風の音だよ", "きっと"], 190, 480, 28, 36, "top");
	out("comic-ja.png", c);
}

// Western comic: English and French bubbles of short centred lines (comic lettering), three
// panels read left to right, top to bottom. Expected order: P1, P2a, P2b, P3 caption, P3a, P3b.
{
	const c = createCanvas(640, 560);
	const g = c.getContext("2d");
	panels(g, 640, 560, [
		[20, 20, 290, 250],
		[330, 20, 290, 250],
		[20, 290, 600, 250],
	]);
	g.font = '19px "Noto Sans"';
	bubble(g, 160, 120, 115, 70, [120, 184, 100, 230, 150, 186]);
	centredLines(g, ["HEY! DID YOU", "HEAR THAT", "NOISE?"], 160, 120, 23);
	bubble(g, 430, 70, 80, 34, [400, 98, 380, 130, 430, 101]);
	centredLines(g, ["WHAT NOISE?"], 430, 70, 23);
	bubble(g, 500, 180, 92, 60, [520, 236, 540, 262, 560, 226]);
	centredLines(g, ["I DIDN'T", "HEAR", "ANYTHING."], 500, 180, 23);
	caption(g, 34, 304, 150, 34, "PLUS TARD...");
	bubble(g, 190, 420, 110, 60, [160, 474, 140, 520, 200, 476]);
	centredLines(g, ["ATTENDS...", "TU ENTENDS ÇA ?"], 190, 420, 23);
	bubble(g, 460, 410, 130, 64, [470, 468, 490, 520, 520, 464]);
	centredLines(g, ["C'EST LE VENT,", "RIEN DE PLUS.", "RENTRONS."], 460, 410, 23);
	out("comic-en-fr.png", c);
}
