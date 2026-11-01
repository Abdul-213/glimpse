import { describe, expect, test } from "bun:test";
import {
	type BlockClass,
	clipboardText,
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

describe("reduceSnip: packs, failures and follow-ups (GLIM-73)", () => {
	const GREEK = [block("g1", 0, "Προσφορά", "el", "translate"), block("g2", 1, "Envío gratis", "es", "translate")];
	const row = {
		lang: L("el"),
		state: "missing" as const,
		resourceIds: ["bergamot-elen"],
		bytes: 31_000_000,
		progress: null,
		segmentIds: ["g1"],
	};
	const withPack = () =>
		fold([
			started,
			{ type: "recognised", runId: RUN, blocks: GREEK },
			{ type: "packs", runId: RUN, rows: [row] },
			translation("g2", "Free shipping"),
			{ type: "done", runId: RUN, result: result({ blocks: GREEK }) },
		]);

	test("a pack row marks its blocks waiting; the row sits in state.packs", () => {
		const s = withPack();
		expect(s.packs).toMatchObject([{ lang: "el", state: "missing", bytes: 31_000_000, blockIds: ["g1"] }]);
		expect(s.blocks[0]?.state).toBe("waiting");
		expect(snipStatus(s)).toEqual({ kind: "partial", done: 1, total: 2 });
	});

	test("install progress: downloading with bytes, then the row disappears when installed", () => {
		const s0 = withPack();
		const s1 = reduceSnip(s0, {
			type: "packInstall",
			lang: L("el"),
			states: [{ status: "downloading", receivedBytes: 12_000_000, totalBytes: 31_000_000 }],
		});
		expect(s1.packs[0]).toMatchObject({ state: "downloading", received: 12_000_000, total: 31_000_000 });
		const s2 = reduceSnip(s1, {
			type: "packInstall",
			lang: L("el"),
			states: [{ status: "installed", version: "1", bundled: false }],
		});
		expect(s2.packs).toEqual([]);
		const s3 = reduceSnip(s1, {
			type: "packInstall",
			lang: L("el"),
			states: [{ status: "failed", error: { kind: "network", message: "x" } }],
		});
		expect(s3.packs[0]?.state).toBe("failed");
	});

	test("follow-up: blocks go back to pending, translate in place, the run ends done", () => {
		const s0 = withPack();
		const s1 = reduceSnip(s0, { type: "followUp", phase: "start", blockIds: ["g1"] });
		expect(s1.phase).toBe("translating");
		expect(s1.blocks[0]?.state).toBe("pending");
		const s2 = fold([translation("g1", "Free shipping offer", true, "el")], s1);
		const s3 = reduceSnip(s2, { type: "followUp", phase: "end" });
		expect(s3.phase).toBe("done");
		expect(s3.error).toBeNull();
		expect(s3.blocks.map((b) => b.state)).toEqual(["done", "done"]);
	});

	test("an E2 whose pack lands clears the error", () => {
		const only = [GREEK[0] as RecognisedBlock];
		const s0 = fold([
			started,
			{ type: "recognised", runId: RUN, blocks: only },
			{ type: "packs", runId: RUN, rows: [row] },
			{ type: "done", runId: RUN, result: result({ blocks: only, error: { kind: "packMissing", message: "" } }) },
		]);
		expect(s0.error).toBe("packMissing");
		expect(snipStatus(s0)).toEqual({ kind: "clipboardUnchanged" });
		const s1 = reduceSnip(s0, { type: "followUp", phase: "start", blockIds: ["g1"] });
		expect(s1.error).toBeNull();
		const s2 = reduceSnip(fold([translation("g1", "Offer", true, "el")], s1), { type: "followUp", phase: "end" });
		expect(s2.phase).toBe("done");
	});

	test("Translate these promotes skipped blocks into the list", () => {
		const s0 = fold([started, { type: "recognised", runId: RUN, blocks: MIXED }]);
		const s1 = reduceSnip(s0, { type: "followUp", phase: "start", blockIds: ["e"], promote: true });
		expect(s1.blocks[4]).toMatchObject({ cls: "translate", promoted: true, state: "pending" });
		expect(skippedBlocks(s1)).toEqual([]);
		expect(listedBlocks(s1).map((b) => b.id)).toEqual(["a", "b", "c", "d", "e"]);
	});

	test("a failed block keeps its source and its failure kind", () => {
		const s = fold([
			started,
			{ type: "recognised", runId: RUN, blocks: MIXED },
			{
				type: "translation",
				runId: RUN,
				translation: {
					blockId: "a",
					text: "",
					final: true,
					failure: {
						kind: "providerTimeout",
						error: { code: "timeout", message: "t", retryable: true, providerId: null },
					},
					from: L("es"),
					to: L("en"),
					via: [],
					provider: null,
				},
			},
		]);
		expect(s.blocks[0]).toMatchObject({
			state: "failed",
			failure: "providerTimeout",
			source: "¿Nos vemos a las ocho?",
		});
	});
});

describe("clipboardText (snip-popup.md §6)", () => {
	test("original: every non-skipped block's OCR text in reading order", () => {
		const s = fold([started, { type: "recognised", runId: RUN, blocks: MIXED }]);
		expect(clipboardText(s, "original")).toBe("¿Nos vemos a las ocho?\n12:45\nDanke dir!\nSee you");
		expect(clipboardText(s, "original", "\r\n")).toBe("¿Nos vemos a las ocho?\r\n12:45\r\nDanke dir!\r\nSee you");
	});
});

describe("original view (GLIM-74, §4 S5/S6)", () => {
	test("toggle flips the view, keeps every block in its slot, status says 'Showing original'", () => {
		const s0 = fold([
			started,
			{ type: "recognised", runId: RUN, blocks: MIXED },
			translation("a", "See you at eight?"),
			translation("c", "Thanks!", true, "de"),
			{ type: "done", runId: RUN, result: result({ blocks: MIXED }) },
		]);
		const s1 = reduceSnip(s0, { type: "toggleOriginal" });
		expect(s1.view).toBe("original");
		expect(s1.blocks).toBe(s0.blocks);
		expect(snipStatus(s1)).toEqual({ kind: "original" });
		const s2 = reduceSnip(s1, { type: "toggleOriginal" });
		expect(s2.view).toBe("translation");
		expect(snipStatus(s2)).toEqual({ kind: "none" });
		expect(reduceSnip(s2, { type: "toggleOriginal", on: false })).toBe(s2);
	});

	test("errors keep 'Clipboard not changed' even in the original view", () => {
		const s = reduceSnip(
			fold([started, { type: "done", runId: RUN, result: result({ error: { kind: "noText", message: "" } }) }]),
			{ type: "toggleOriginal", on: true },
		);
		expect(snipStatus(s)).toEqual({ kind: "clipboardUnchanged" });
	});

	test("show original under translation comes from settings at open", () => {
		expect(initialSnipState(RUN).showOriginalUnder).toBe(false);
		expect(initialSnipState(RUN, { showOriginalUnder: true }).showOriginalUnder).toBe(true);
		const opened = reduceSnip(initialSnipState("x"), { type: "open", requestId: RUN, showOriginalUnder: true });
		expect(opened.showOriginalUnder).toBe(true);
		expect(opened.view).toBe("translation");
	});
});
