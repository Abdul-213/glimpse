// Renders mixed-ja-de.png (GLIM-109): one 1x "desktop" frame with real text for the harness's
// real-OCR pipeline run (PaddleOCR -> grouping -> ELD detection -> Bergamot): a Japanese
// paragraph wrapped over two lines, a German sentence, an English button label and a number.
// Not part of the build; the PNG is committed. To re-render (same tools as
// packages/providers/test/fixtures/ocr/make-fixtures.mjs):
//   (cd ~/.cache/glimpse-fixture-tools && bun add @napi-rs/canvas@1.1.0)
//   CANVAS=~/.cache/glimpse-fixture-tools/node_modules/@napi-rs/canvas/index.js bun make.mjs
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const { createCanvas, GlobalFonts } = await import(process.env.CANVAS ?? "@napi-rs/canvas");
const FONTS = process.env.GLIM_FONT_DIR ?? join(homedir(), ".cache", "glim17", "fonts");
GlobalFonts.registerFromPath(join(FONTS, "NotoSansJP.ttf"), "Noto Sans JP");
GlobalFonts.registerFromPath(join(FONTS, "NotoSans.ttf"), "Noto Sans");

const c = createCanvas(720, 300);
const g = c.getContext("2d");
g.fillStyle = "#20242c";
g.fillRect(0, 0, 720, 300);
// A window.
g.fillStyle = "#f5f5f0";
g.fillRect(20, 20, 680, 260);
g.fillStyle = "#111";
g.textBaseline = "top";
g.font = '22px "Noto Sans JP"';
g.fillText("明日の会議は午後三時に始まります。資料は", 44, 44);
g.fillText("共有フォルダに保存しました。", 44, 76);
g.font = '22px "Noto Sans"';
g.fillText("Die Datei konnte nicht gespeichert werden.", 44, 140);
g.fillText("42", 44, 200);
g.fillStyle = "#0066cc";
g.fillRect(560, 214, 110, 40);
g.fillStyle = "#fff";
g.fillText("Cancel", 580, 222);
writeFileSync(join(import.meta.dir, "mixed-ja-de.png"), c.toBuffer("image/png"));
