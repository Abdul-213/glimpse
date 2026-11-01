// GLIM-64: the benchmark's scoring and regression gate, and the corpus' ground truth.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type BlockLanguage, languageCode, type OcrBlock, type Rect } from "@glimpse/core";
import {
	type Baseline,
	type CaseResult,
	type Corpus,
	type CorpusCase,
	charEdits,
	editDistance,
	percentile,
	regressions,
	scoreCase,
	summariseAll,
	toBaseline,
	wordEdits,
} from "../../bench/ocr/metrics.ts";
import { renderReport } from "../../bench/ocr/report.ts";
import { decodePng } from "../helpers/png.ts";

const box = (x: number, y: number, width = 100, height = 20): Rect => ({ x, y, width, height });
const lang = (l: string): BlockLanguage => ({ kind: "language", lang: languageCode(l), confidence: 0.9 });
const block = (id: string, lines: { text: string; box: Rect }[]): OcrBlock => ({
	id,
	box: lines[0]?.box ?? box(0, 0),
	text: lines.map((l) => l.text).join("\n"),
	confidence: 0.9,
	lines: lines.map((l) => ({ ...l, confidence: 0.9 })),
});

const dialog: CorpusCase = {
	id: "t",
	image: "",
	width: 400,
	height: 200,
	script: "Latin",
	kind: "rendered",
	sources: ["en"],
	blocks: [
		{ lang: "en", lines: [{ text: "Save changes?", box: box(10, 10) }] },
		{
			lang: "en",
			lines: [
				{ text: "If you close it now", box: box(10, 50) },
				{ text: "the edits are lost.", box: box(10, 75) },
			],
		},
	],
};

describe("text metrics", () => {
	test("edit distance", () => {
		expect(editDistance([..."kitten"], [..."sitting"])).toBe(3);
		expect(editDistance([], [..."abc"])).toBe(3);
		expect(editDistance([..."abc"], [..."abc"])).toBe(0);
	});
	test("character edits ignore spacing and NFKC differences", () => {
		expect(charEdits("Save changes?", "Save  changes？")).toBe(0);
		expect(charEdits("Savechanges?", "Save changes?")).toBe(0);
		expect(charEdits("Сохранить", "CoxpaHnTb")).toBe(9);
	});
	test("word edits", () => {
		expect(wordEdits("the edits are lost", "the edit are lost")).toBe(1);
	});
	test("nearest-rank percentile", () => {
		expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
		expect(percentile([], 0.5)).toBe(0);
	});
});

describe("scoreCase", () => {
	test("a perfect read: no errors, every block exact, in order, detected", () => {
		const blocks = [
			block("b0", [{ text: "Save changes?", box: box(12, 8, 96, 24) }]),
			block("b1", [
				{ text: "If you close it now", box: box(10, 50) },
				{ text: "the edits are lost.", box: box(10, 75) },
			]),
		];
		const s = scoreCase(dialog, blocks, [lang("en"), lang("en")]);
		expect(s.cer).toBe(0);
		expect(s.wer).toBe(0);
		expect(s.blocks).toMatchObject({ truth: 2, got: 2, exact: 2, split: 0, merged: 0 });
		expect(s.orderCorrect).toBe(true);
		expect(s.detection).toMatchObject({ correct: 2, total: 2 });
	});

	test("merged blocks, a false-positive line and a wrong language", () => {
		const blocks = [
			block("b0", [
				{ text: "Save changes?", box: box(10, 10) },
				{ text: "If you close it now", box: box(10, 50) },
				{ text: "the edits are lost.", box: box(10, 75) },
			]),
			block("b1", [{ text: "xyz", box: box(300, 170, 40, 20) }]),
		];
		const s = scoreCase(dialog, blocks, [lang("de"), lang("en")]);
		expect(s.extra).toEqual(["xyz"]);
		expect(s.charEdits).toBe(3);
		expect(s.blocks).toMatchObject({ exact: 0, merged: 1 });
		expect(s.blocks.notes[0]).toContain("merged");
		expect(s.detection.correct).toBe(0);
		expect(s.detection.misses[0]).toMatchObject({ expected: "en", got: "de" });
	});

	test("a line split by the engine is re-joined (RTL right to left) and a block split counts", () => {
		const ar: CorpusCase = {
			...dialog,
			blocks: [{ lang: "ar", lines: [{ text: "حفظ الإعدادات", box: box(10, 10, 200, 20) }] }],
		};
		const blocks = [
			block("b0", [{ text: "الإعدادات", box: box(10, 10, 110, 20) }]),
			block("b1", [{ text: "حفظ", box: box(150, 10, 60, 20) }]),
		];
		const s = scoreCase(ar, blocks, [lang("ar"), lang("ar")]);
		expect(s.lines[0]?.got).toBe("حفظ الإعدادات");
		expect(s.cer).toBe(0);
		expect(s.blocks).toMatchObject({ exact: 0, split: 1 });
	});

	test("reading order", () => {
		const blocks = [
			block("b0", [
				{ text: "If you close it now", box: box(10, 50) },
				{ text: "the edits are lost.", box: box(10, 75) },
			]),
			block("b1", [{ text: "Save changes?", box: box(10, 10) }]),
		];
		expect(scoreCase(dialog, blocks).orderCorrect).toBe(false);
	});

	test("no WER for scripts written without spaces", () => {
		const ja: CorpusCase = {
			...dialog,
			blocks: [{ lang: "ja", lines: [{ text: "設定を保存しました", box: box(0, 0) }] }],
		};
		const s = scoreCase(ja, [block("b0", [{ text: "設定を保存した", box: box(0, 0) }])]);
		expect(s.wer).toBeNull();
		expect(s.charEdits).toBe(2);
	});
});

describe("regression gate", () => {
	const result = (cer: number, ms: number): CaseResult => ({
		id: "t",
		script: "Latin",
		kind: "rendered",
		score: { ...scoreCase(dialog, []), charEdits: Math.round(cer * 100), chars: 100 },
		firstMs: ms,
		runs: [ms, ms, ms],
	});
	const base: Baseline = toBaseline(summariseAll([result(0.02, 100)]), "test");

	test("small changes pass", () => {
		expect(regressions(summariseAll([result(0.04, 250)]), base)).toEqual([]);
	});
	test("a large CER rise fails", () => {
		const r = regressions(summariseAll([result(0.08, 100)]), base);
		expect(r).toHaveLength(1);
		expect(r[0]).toContain("Latin: CER");
	});
	test("latency only fails beyond the factor, and can be turned off", () => {
		expect(regressions(summariseAll([result(0.02, 400)]), base)[0]).toContain("latency");
		expect(regressions(summariseAll([result(0.02, 400)]), base, undefined, { latency: false })).toEqual([]);
	});
	test("a script that stopped running fails", () => {
		const other = { ...result(0, 100), script: "Greek" };
		expect(regressions(summariseAll([other]), base)[0]).toContain("no cases ran");
	});
	test("the report renders every case", () => {
		const corpus: Corpus = { schema: 1, cases: [dialog] };
		const md = renderReport({
			summary: summariseAll([result(0.02, 100)]),
			results: [result(0.02, 100)],
			skipped: [],
			machine: "test",
			initMs: 1,
			warmupMs: 1,
			iterations: 3,
			corpus,
		});
		expect(md).toContain("| t | rendered | 400x200 |");
	});
});

describe("corpus", async () => {
	const dir = join(import.meta.dir, "..", "..", "bench", "ocr");
	const corpus = (await Bun.file(join(dir, "corpus.json")).json()) as Corpus;
	const baseline = (await Bun.file(join(dir, "baseline.json")).json()) as Baseline;

	test("covers Latin, CJK, Arabic, Cyrillic and Devanagari, rendered and screenshot-like", () => {
		const scripts = new Set(corpus.cases.map((c) => c.script));
		for (const s of ["Latin", "CJK", "Arabic", "Cyrillic", "Devanagari"]) expect(scripts.has(s)).toBe(true);
		expect(new Set(corpus.cases.map((c) => c.kind))).toEqual(new Set(["rendered", "screenshot-like"]));
		expect(new Set(corpus.cases.map((c) => c.id)).size).toBe(corpus.cases.length);
	});

	test("every case: image matches its size, boxes inside it, block languages in its sources", async () => {
		for (const c of corpus.cases) {
			const img = decodePng(new Uint8Array(await Bun.file(join(dir, c.image)).arrayBuffer()));
			expect([c.id, img.width, img.height]).toEqual([c.id, c.width, c.height]);
			for (const b of c.blocks) {
				expect(c.sources).toContain(b.lang);
				for (const l of b.lines) {
					expect(l.text.length).toBeGreaterThan(0);
					expect(l.box.x >= 0 && l.box.y >= 0).toBe(true);
					expect(l.box.x + l.box.width <= c.width && l.box.y + l.box.height <= c.height).toBe(true);
				}
			}
		}
	});

	test("the baseline covers every script in the corpus", () => {
		expect(Object.keys(baseline.scripts).sort()).toEqual([...new Set(corpus.cases.map((c) => c.script))].sort());
	});
});
