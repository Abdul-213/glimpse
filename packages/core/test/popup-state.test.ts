import { describe, expect, test } from "bun:test";
import {
	type BlockClass,
	initialSnipState,
	type LanguageCode,
	languageCode,
	listedBlocks,
	type PipelineEvent,
	type PipelineResult,
	type RecognisedBlock,
	rect,
	reduceSnip,
	type SnipPopupState,
	showLanguageTags,
	skippedBlocks,
	skippedLanguages,
	snipStatus,
	TranslationCache,
	TranslationPipeline,
} from "../src/index.ts";
import { blankImage, FakeOcrProvider, FakeTranslationProvider, ocrBlock } from "../src/testing/index.ts";

const L = languageCode;
const RUN = "run-1";

const block = (id: string, order: number, text: string, lang: string | null, cls: BlockClass): RecognisedBlock => ({
	id,
	order,
	box: rect(0, order * 30, 200, 20),
	text,
	confidence: 0.9,
	language: lang ? { kind: "language", lang: L(lang), confidence: 1 } : { kind: "skipped", lang: null, confidence: 0 },
	lang: lang ? L(lang) : null,
	cls,
	direction: lang === "ar" || lang === "he" ? "rtl" : "ltr",
	waitingForPack: false,
});

const fold = (events: readonly PipelineEvent[], start: SnipPopupState = initialSnipState(RUN)) =>
	events.reduce((s, event) => reduceSnip(s, { type: "pipeline", event }), start);

const translation = (blockId: string, text: string, final = true, from = "es"): PipelineEvent => ({
	type: "translation",
	runId: RUN,
	translation: { blockId, text, final, failure: null, from: L(from), to: L("en"), via: [], provider: null },
});

const result = (over: Partial<PipelineResult> = {}): PipelineResult => ({
	runId: RUN,
	mode: "snip",
	target: L("en"),
	blocks: [],
	translations: {},
	packs: [],
	done: 0,
	total: 0,
	error: null,
	ocr: null,
	translators: [],
	cloud: false,
	private: false,
	timings: { ocrMs: 0, translateMs: 0, totalMs: 0 },
	...over,
});

const started: PipelineEvent = {
	type: "started",
	runId: RUN,
	mode: "snip",
	target: L("en"),
	private: false,
	ocr: { id: "paddleocr", kind: "local", name: "PaddleOCR" },
	translation: { id: "bergamot", kind: "local", name: "On-device translation" },
};

const MIXED = [
	block("a", 0, "¿Nos vemos a las ocho?", "es", "translate"),
	block("b", 1, "12:45", null, "neutral"),
	block("c", 2, "Danke dir!", "de", "translate"),
	block("d", 3, "See you", "en", "target"),
	block("e", 4, "Увидимся завтра", "ru", "skip"),
];

describe("reduceSnip: the main path (snip-popup.md §4 S0-S4)", () => {
	test("S0 opened: two static skeleton bars, 'Reading text'", () => {
		const s = initialSnipState(RUN);
		expect(s.phase).toBe("opened");
		expect(s.skeletons).toEqual([70, 45]);
		expect(snipStatus(s)).toEqual({ kind: "reading" });
	});

	test("S1 detected: one bar per box, its width share clamped to 30-100 %, top to bottom", () => {
		const s = fold([
			started,
			{
				type: "detected",
				runId: RUN,
				image: { width: 400, height: 200 },
				boxes: [
					{ id: "x", box: rect(0, 100, 40, 20) },
					{ id: "y", box: rect(0, 10, 300, 20) },
					{ id: "z", box: rect(0, 50, 500, 20) },
				],
			},
		]);
		expect(s.phase).toBe("detected");
		expect(s.skeletons).toEqual([75, 100, 30]);
		expect(snipStatus(s)).toEqual({ kind: "reading" });
	});

	test("S2 recognised: translate-class pending, neutral and target final, skipped counted", () => {
		const s = fold([started, { type: "recognised", runId: RUN, blocks: MIXED }]);
		expect(s.skeletons).toEqual([]);
		expect(s.blocks.map((b) => [b.id, b.state])).toEqual([
			["a", "pending"],
			["b", "done"],
			["c", "pending"],
			["d", "done"],
			["e", "done"],
		]);
		expect(listedBlocks(s).map((b) => b.id)).toEqual(["a", "b", "c", "d"]);
		expect(skippedBlocks(s).map((b) => b.id)).toEqual(["e"]);
		expect(skippedLanguages(s)).toEqual([L("ru")]);
		expect(snipStatus(s)).toEqual({ kind: "translating", done: 0, total: 2 });
	});

	test("S3 slot stability: a late translation for block 1 never moves block 3", () => {
		const s0 = fold([started, { type: "recognised", runId: RUN, blocks: MIXED }]);
		const s1 = fold([translation("c", "Thanks!", true, "de")], s0);
		expect(s1.blocks.map((b) => b.id)).toEqual(["a", "b", "c", "d", "e"]);
		expect(s1.blocks[2]?.translation).toBe("Thanks!");
		expect(s1.blocks[0]?.state).toBe("pending");
		const s2 = fold([translation("a", "See you at eight?")], s1);
		expect(s2.blocks.map((b) => b.id)).toEqual(["a", "b", "c", "d", "e"]);
		expect(s2.blocks[0]?.state).toBe("done");
		// Unchanged blocks keep their identity, so the view doesn't re-render them.
		expect(s2.blocks[2]).toBe(s1.blocks[2] as (typeof s2.blocks)[number]);
	});

	test("streaming: a non-final translation shows translated sentences + remaining source, still pending", () => {
		const s0 = fold([started, { type: "recognised", runId: RUN, blocks: MIXED }]);
		const s1 = fold([translation("a", "See you at eight? ¿Y tú?", false)], s0);
		expect(s1.blocks[0]?.state).toBe("pending");
		expect(s1.blocks[0]?.translation).toBe("See you at eight? ¿Y tú?");
	});

	test("S4 done: phase done, status clears; progress tracks the pipeline's count", () => {
		const s = fold([
			started,
			{ type: "recognised", runId: RUN, blocks: MIXED },
			translation("a", "See you at eight?"),
			{ type: "progress", runId: RUN, done: 1, total: 2 },
			translation("c", "Thanks!", true, "de"),
			{ type: "progress", runId: RUN, done: 2, total: 2 },
			{ type: "done", runId: RUN, result: result({ blocks: MIXED, done: 2, total: 2 }) },
		]);
		expect(s.phase).toBe("done");
		expect(s.error).toBeNull();
		expect(snipStatus(s)).toEqual({ kind: "none" });
	});

	test("events from another run are dropped (a quick second Snip can't mix results)", () => {
		const s0 = fold([started, { type: "recognised", runId: RUN, blocks: MIXED }]);
		const s1 = reduceSnip(s0, {
			type: "pipeline",
			event: { type: "recognised", runId: "older", blocks: [] },
		});
		expect(s1).toBe(s0);
	});
});

describe("reduceSnip: tags, skipped line, provider", () => {
	test("language tags only when two or more source languages, or the setting", () => {
		const two = fold([started, { type: "recognised", runId: RUN, blocks: MIXED }]);
		expect(showLanguageTags(two)).toBe(true);
		const one = fold([
			started,
			{ type: "recognised", runId: RUN, blocks: [MIXED[0] as RecognisedBlock, MIXED[3] as RecognisedBlock] },
		]);
		expect(showLanguageTags(one)).toBe(false);
		const always = fold(
			[started, { type: "recognised", runId: RUN, blocks: [MIXED[0] as RecognisedBlock] }],
			initialSnipState(RUN, { alwaysShowLanguages: true }),
		);
		expect(showLanguageTags(always)).toBe(true);
	});

	test("the skipped line expands and collapses; E5 opens it", () => {
		const s0 = fold([started, { type: "recognised", runId: RUN, blocks: MIXED }]);
		expect(reduceSnip(s0, { type: "toggleSkipped" }).skippedExpanded).toBe(true);
		expect(reduceSnip(s0, { type: "toggleSkipped", expanded: false }).skippedExpanded).toBe(false);
		const onlySkipped = [MIXED[4] as RecognisedBlock];
		const e5 = fold([
			started,
			{ type: "recognised", runId: RUN, blocks: onlySkipped },
			{
				type: "done",
				runId: RUN,
				result: result({ blocks: onlySkipped, error: { kind: "nothingToTranslate", message: "" } }),
			},
		]);
		expect(e5.phase).toBe("error");
		expect(e5.error).toBe("nothingToTranslate");
		expect(e5.skippedExpanded).toBe(true);
	});

	test("local providers: 'On device'; a cloud translator: its name, remembered when every result was cached", () => {
		expect(fold([started]).provider).toEqual({ kind: "local" });
		const cloud = {
			id: "cloud:google-translate-v2",
			kind: "cloud" as const,
			name: "Google Cloud Translation",
			providerId: "cloud:google-translate-v2",
			modelRevision: "v2",
			optionsHash: "x",
			remembered: true as const,
		};
		const s = fold([
			started,
			{ type: "recognised", runId: RUN, blocks: [MIXED[0] as RecognisedBlock] },
			{ type: "done", runId: RUN, result: result({ translators: [cloud], translations: {} }) },
		]);
		expect(s.provider).toMatchObject({
			kind: "cloud",
			name: "Google Cloud Translation",
			remembered: true,
			sent: "text",
		});
	});
});

describe("reduceSnip over the real pipeline (core fakes)", () => {
	test("a Snip folds to every block translated, in reading order", async () => {
		const ocr = new FakeOcrProvider({
			blocks: [
				ocrBlock("b1", "設定を保存しました。", rect(0, 0, 200, 20)),
				ocrBlock("b2", "100", rect(0, 30, 40, 20)),
				ocrBlock("b3", "안녕하세요", rect(0, 60, 100, 20)),
			],
		});
		const tr = new FakeTranslationProvider({ capabilities: { streaming: false } });
		await ocr.init();
		await tr.init();
		const pipeline = new TranslationPipeline({ ocr: () => ocr, chain: () => [tr] });
		let state = initialSnipState(RUN);
		const statuses: string[] = [];
		await pipeline.run(blankImage(400, 200, "rgba8"), {
			mode: "snip",
			runId: RUN,
			target: L("en"),
			sources: [L("ja") as LanguageCode],
			cache: new TranslationCache(),
			private: false,
			onEvent: (event) => {
				state = reduceSnip(state, { type: "pipeline", event });
				statuses.push(snipStatus(state).kind);
			},
		});
		expect(state.phase).toBe("done");
		expect(state.blocks.map((b) => [b.cls, b.state])).toEqual([
			["translate", "done"],
			["neutral", "done"],
			["skip", "done"],
		]);
		expect(state.blocks[0]?.translation).toBe("設定を保存しました。 [ja>en]");
		expect(statuses[0]).toBe("reading");
		expect(statuses).toContain("translating");
		expect(statuses.at(-1)).toBe("none");
	});
});
