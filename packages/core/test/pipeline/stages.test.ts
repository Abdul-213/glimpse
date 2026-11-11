// GLIM-109: the real grouper (GLIM-56) and detector (GLIM-49) behind the pipeline's ports.
import { describe, expect, test } from "bun:test";
import {
	glim21Detector,
	type LanguageCode,
	type LanguageDetector,
	LivePipelineSession,
	languageCode,
	lineGrouper,
	type OcrBlock,
	type PipelineResult,
	rect,
	TranslationCache,
	TranslationCaches,
	TranslationPipeline,
} from "../../src/index.ts";
import {
	blankImage,
	FakeLanguageDetector,
	FakeOcrProvider,
	FakeTranslationProvider,
	ocrBlock,
} from "../../src/testing/index.ts";

const L = languageCode;
const image = blankImage(800, 400, "rgba8");

describe("lineGrouper", () => {
	const g = lineGrouper();

	test("groups engine lines into blocks in reading order, keeping the lines", () => {
		const out = g.group(
			[
				ocrBlock("l2", "a paragraph that is quite long", rect(10, 32, 300, 20)),
				ocrBlock("l1", "This is the first line of what is", rect(10, 10, 320, 20)),
				ocrBlock("l3", "Help", rect(10, 120, 40, 20)),
			],
			image,
		);
		expect(out.map((b) => b.text)).toEqual([
			"This is the first line of what is\na paragraph that is quite long",
			"Help",
		]);
		expect(out.map((b) => b.id)).toEqual(["b0", "b1"]);
		expect(out[0]?.lines).toHaveLength(2);
	});

	test("blocks the engine already grouped pass through untouched", () => {
		const grouped: OcrBlock[] = [
			{
				...ocrBlock("b0", "Hello", rect(0, 0, 50, 20)),
				lines: [{ box: rect(0, 0, 50, 20), text: "Hello", confidence: 1 }],
			},
		];
		expect(g.group(grouped, image)).toBe(grouped);
		expect(g.group([], image)).toEqual([]);
	});

	test("mixed input keeps engine blocks and gives grouped ones ids that can't clash", () => {
		const out = g.group(
			[{ ...ocrBlock("b0", "Hello", rect(0, 0, 50, 20)), lines: [] }, ocrBlock("x", "World", rect(0, 200, 50, 20))],
			image,
		);
		expect(out.map((b) => b.id)).toEqual(["b0", "g0"]);
	});
});

/** A pipeline over scripted OCR blocks (a function, so Live frames can change them). */
function pipelineWith(blocks: () => readonly OcrBlock[], detector: ReturnType<typeof glim21Detector>) {
	const ocr = new FakeOcrProvider({ blocks: () => blocks() });
	const translator = new FakeTranslationProvider({ capabilities: { streaming: false }, pivot: "en" });
	const pipeline = new TranslationPipeline({
		ocr: () => ocr,
		chain: () => [translator],
		grouper: lineGrouper(),
		detector,
	});
	return { ocr, translator, pipeline };
}

const eld = () =>
	new FakeLanguageDetector({
		"Die Datei konnte nicht gespeichert werden": [
			["de", 0.9],
			["nl", 0.3],
		],
		"Bonjour à tous les amis": [["fr", 0.85]],
		"The file was saved": [["en", 0.92]],
		Merci: [["en", 0.6]],
	});

const snip = async (
	pipeline: TranslationPipeline,
	target: string,
	sources: readonly LanguageCode[],
): Promise<PipelineResult> =>
	pipeline.run(image, { mode: "snip", target: L(target), sources, cache: new TranslationCache(), private: false });

const classes = (r: PipelineResult) => r.blocks.map((b) => [b.text, b.cls, b.lang]);

describe("glim21Detector in the pipeline (GLIM-21 per block)", () => {
	// One block per line, spaced so the grouper keeps them apart.
	const mixed = [
		ocrBlock("l0", "明日の会議は午後三時に始まります。", rect(10, 10, 420, 24)),
		ocrBlock("l1", "Die Datei konnte nicht gespeichert werden.", rect(10, 80, 460, 24)),
		ocrBlock("l2", "42", rect(10, 150, 30, 24)),
		ocrBlock("l3", "Bonjour à tous les amis", rect(10, 220, 260, 24)),
		ocrBlock("l4", "The file was saved", rect(10, 290, 200, 24)),
	];

	test("a mixed-language capture: script, detector, neutral, subset and target rules", async () => {
		const { ocr, translator, pipeline } = pipelineWith(() => mixed, glim21Detector({ detectors: [eld()] }));
		await ocr.init();
		await translator.init();
		const r = await snip(pipeline, "en", [L("ja"), L("de")]);
		expect(classes(r)).toEqual([
			["明日の会議は午後三時に始まります。", "translate", "ja"], // rule 3 (kana)
			["Die Datei konnte nicht gespeichert werden.", "translate", "de"], // rule 4
			["42", "neutral", null], // rule 1
			["Bonjour à tous les amis", "skip", "fr"], // rule 4, outside the subset
			["The file was saved", "skip", "en"], // English is outside the subset too
		]);
		expect(r.translations[r.blocks[1]?.id ?? ""]?.text).toBe("Die Datei konnte nicht gespeichert werden. [de>en]");

		// No subset: everything is translated except neutral and target-language blocks.
		const all = await snip(pipeline, "en", []);
		expect(all.blocks.map((b) => b.cls)).toEqual(["translate", "translate", "neutral", "translate", "target"]);
		// German text with target de stays as it is (the stand-in used to call it English).
		const de = await snip(pipeline, "de", []);
		expect(de.blocks[1]).toMatchObject({ cls: "target", lang: "de" });
	});

	test("the detector library loads once, lazily; a failed load falls back to the script rules", async () => {
		let loads = 0;
		const lazy = glim21Detector({
			detectors: async () => {
				loads++;
				return [eld()];
			},
		});
		const a = pipelineWith(() => mixed, lazy);
		await a.ocr.init();
		await a.translator.init();
		await snip(a.pipeline, "en", []);
		await snip(a.pipeline, "en", []);
		expect(loads).toBe(1);

		const errors: unknown[] = [];
		const broken = glim21Detector({
			detectors: () => Promise.reject(new Error("no database")),
			onLoadError: (e) => errors.push(e),
		});
		const b = pipelineWith(() => mixed, broken);
		await b.ocr.init();
		await b.translator.init();
		const r = await snip(b.pipeline, "en", [L("ja"), L("de")]);
		expect(errors).toHaveLength(1);
		expect(r.blocks[0]).toMatchObject({ cls: "translate", lang: "ja" });
		expect(r.blocks[2]).toMatchObject({ cls: "neutral" });
	});

	test("invalidate (GLIM-104): a downloaded detector joins on the next load", async () => {
		let loads = 0;
		let installed = false;
		const lazy = glim21Detector({
			detectors: async () => {
				loads++;
				return installed ? [eld(), new FakeLanguageDetector({}, { id: "fasttext-like" })] : [eld()];
			},
		});
		const a = pipelineWith(() => mixed, lazy);
		await a.ocr.init();
		await a.translator.init();
		await snip(a.pipeline, "en", []);
		installed = true;
		await snip(a.pipeline, "en", []);
		expect(loads).toBe(1);
		lazy.invalidate();
		await lazy.load();
		await snip(a.pipeline, "en", []);
		expect(loads).toBe(2);
		// A fixed list has nothing to reload.
		const fixed = glim21Detector({ detectors: [eld()] });
		fixed.invalidate();
		await fixed.load();
	});

	test("the detector is planned per subset: no library covering it means script rules only", async () => {
		const detectors: LanguageDetector[] = [new FakeLanguageDetector({}, { id: "only-en", languages: ["en"] })];
		const { ocr, translator, pipeline } = pipelineWith(() => mixed, glim21Detector({ detectors }));
		await ocr.init();
		await translator.init();
		const r = await snip(pipeline, "en", [L("ja")]);
		// Latin text with a Japanese-only subset is skipped by rule 2 whatever the library says.
		expect(r.blocks.map((b) => b.cls)).toEqual(["translate", "skip", "neutral", "skip", "skip"]);
	});

	test("OCR language hints (Vision detectedLanguages) reach detection as a prior", async () => {
		// Too short for the detector; without the hint it would be skipped (nothing to go on).
		// Vision blocks come already grouped (with `lines`), so the grouper keeps them and their hints.
		const box = rect(10, 10, 80, 24);
		const hinted: OcrBlock[] = [
			{
				...ocrBlock("h", "Ok sim", box),
				lines: [{ box, text: "Ok sim", confidence: 0.9 }],
				languageHints: [{ lang: L("pt"), confidence: 0.8 }],
			},
		];
		const { ocr, translator, pipeline } = pipelineWith(() => hinted, glim21Detector({ detectors: [] }));
		await ocr.init();
		await translator.init();
		const r = await snip(pipeline, "en", []);
		expect(r.blocks[0]).toMatchObject({ cls: "translate", lang: "pt" });
	});
});

describe("glim21Detector in Live (hysteresis over stable block ids)", () => {
	test("an uncertain different language doesn't flip a block between frames; setSources resets", async () => {
		let frame: OcrBlock[] = [ocrBlock("x", "Bonjour à tous les amis", rect(10, 10, 260, 24))];
		const { ocr, translator, pipeline } = pipelineWith(() => frame, glim21Detector({ detectors: [eld()] }));
		await ocr.init();
		await translator.init();
		const session = new LivePipelineSession({
			pipeline,
			caches: new TranslationCaches({ now: () => 0 }),
			target: L("ja"),
			sources: [],
			private: false,
		});
		const first = await session.process(image);
		expect(first?.blocks[0]).toMatchObject({ lang: "fr", cls: "translate" });
		const id = first?.blocks[0]?.id;

		// Same place, new short text the detector alone would call English.
		frame = [ocrBlock("y", "Merci", rect(10, 10, 240, 24))];
		const second = await session.process(image);
		expect(second?.blocks[0]?.id).toBe(id);
		expect(second?.blocks[0]).toMatchObject({ lang: "fr" });

		// A new subset drops the session's decisions: the short block is decided afresh.
		session.setSources([]);
		const third = await session.process(image);
		expect(third?.blocks[0]).toMatchObject({ lang: "en" });
		session.close();
	});
});
