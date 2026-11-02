// SMaLL-100 with the real model (GLIM-100). Env-gated: set GLIMPSE_SMALL100_DIR to an installed
// `small100` model folder (encoder_model_quantized.onnx, decoder_model_merged_quantized.onnx,
// tokenizer.json): the app's <models>/small100/ after a download, or the three manifest files.
//
// Checks the TypeScript tokenizer against transformers' M2M100Tokenizer (Python, SMaLL-100's own
// sentencepiece.bpe.model + vocab.json; ids below), then translates through the real Worker.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectTranslations, languageCode } from "@glimpse/core";
import { SMALL100_FILES, Small100Tokenizer, Small100TranslationProvider, staticSmall100Source } from "../src/index.ts";

const DIR = process.env["GLIMPSE_SMALL100_DIR"];
const L = languageCode;

/** transformers 4.46.3 M2M100Tokenizer(add_special_tokens=False) over SMaLL-100's files. */
const REFERENCE = [
	{ text: "Habari za asubuhi, unaendeleaje?", ids: [36148, 181, 285, 16100, 612, 4, 233, 32484, 166, 24] },
	{
		text: "明日の会議は午後三時に始まります。",
		ids: [22, 4418, 28867, 1758, 21180, 545, 39899, 5352, 5075, 33099, 22524, 5276, 17395, 37],
	},
	{ text: "Die Datei konnte nicht gespeichert werden.", ids: [1104, 42539, 101, 40210, 1446, 77223, 106383, 2697, 5] },
	{ text: "ሰላም ለዓለም።", ids: [77132, 3874, 46148, 4706] },
	{
		text: "  Ünïcödé — “quotes” & 123,456.78 ",
		ids: [109496, 6460, 143, 10092, 197, 355, 41, 1111, 26484, 89, 1011, 575, 3540, 3834, 2881, 7049],
	},
];

describe.skipIf(!DIR)("SMaLL-100 real model (GLIMPSE_SMALL100_DIR)", () => {
	test("the TypeScript tokenizer matches transformers' SentencePiece ids", () => {
		const json = JSON.parse(readFileSync(join(DIR ?? "", SMALL100_FILES.tokenizer), "utf8")) as object;
		const tok = new Small100Tokenizer(json);
		for (const { text, ids } of REFERENCE) expect(tok.encode(text)).toEqual(ids);
		expect([tok.language("sw"), tok.language("en"), tok.language("ja")]).toEqual([128088, 128022, 128046]);
	});

	test("translates through the Worker, streams a multi-sentence segment, and stops when idle", async () => {
		const provider = new Small100TranslationProvider({
			model: staticSmall100Source({ dir: DIR ?? "", revision: "test" }),
			idleMs: 0,
		});
		await provider.init();
		const t0 = performance.now();
		const out = await collectTranslations(provider, {
			to: L("en"),
			segments: [
				{ id: "sw", text: "Habari za asubuhi. Faili haikuweza kuhifadhiwa.", from: L("sw") },
				{ id: "am", text: "ሰላም ለዓለም።", from: L("am") },
			],
		});
		const ms = performance.now() - t0;
		const sw = out.get("sw");
		expect(sw?.ok).toBe(true);
		const text = sw?.ok ? sw.translation.text : "";
		expect(text.toLowerCase()).toMatch(/morning/);
		expect(text.toLowerCase()).toMatch(/file|saved/);
		expect(out.get("am")?.ok).toBe(true);
		console.log(`small100 real: ${ms.toFixed(0)} ms incl. load | ${text}`);
		await provider.dispose();
	}, 120_000);
});
