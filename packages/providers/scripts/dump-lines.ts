// Write OCR lines (before grouping) of the layout fixtures as JSON, for core's GLIM-56 tests:
//   bun scripts/dump-lines.ts   -> packages/core/test/fixtures/ocr-lines/<name>.json
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { languageCode, type OcrLine } from "@glimpse/core";
import { PaddleOcrProvider } from "../src/ocr/paddle/paddle-provider.ts";
import { cacheSource, FIXTURES } from "../test/helpers/models.ts";
import { loadPng } from "../test/helpers/png.ts";

const out = join(import.meta.dir, "../../core/test/fixtures/ocr-lines");
mkdirSync(out, { recursive: true });
const cases: [string, string[]][] = [
	["screen-1920x1080", ["ja", "zh-Hans", "de", "en", "ko"]],
	["columns-en", ["en"]],
	["vertical-ja", ["ja"]],
	["region-en", ["en"]],
	["region-game-dark", ["ja"]],
];
const p = new PaddleOcrProvider({ grouping: "lines" }, { models: cacheSource });
await p.init();
for (const [name, langs] of cases) {
	const r = await p.recognise({
		image: await loadPng(join(FIXTURES, `${name}.png`)),
		languages: langs.map(languageCode),
	});
	const lines: OcrLine[] = r.blocks.map((b) => ({
		box: b.box,
		text: b.text,
		confidence: Number(b.confidence.toFixed(3)),
	}));
	await Bun.write(join(out, `${name}.json`), `${JSON.stringify(lines, null, "\t")}\n`);
	console.log(name, lines.length);
}
await p.dispose();
