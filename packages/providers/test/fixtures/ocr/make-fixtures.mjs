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
