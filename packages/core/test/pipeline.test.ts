import { describe, expect, test } from "bun:test";
import {
	CaptureError,
	type CaptureFrame,
	functionDetector,
	isProviderError,
	type LanguageCode,
	LivePipelineSession,
	languageCode,
	type OcrBlock,
	type PipelineEvent,
	type PipelineResult,
	rect,
	scriptLanguageDetector,
	TranslationCache,
	TranslationCaches,
	TranslationPipeline,
	type TranslationProvider,
} from "../src/index.ts";
import {
	blankImage,
	FakeOcrProvider,
	type FakeTranslationOptions,
	FakeTranslationProvider,
	manualGate,
	ocrBlock,
} from "../src/testing/index.ts";

const L = languageCode;
const image = blankImage(400, 200, "rgba8");

const blocks = {
	ja: ocrBlock("b1", "設定を保存しました。次へ進みます。", rect(0, 0, 200, 20)),
	neutral: ocrBlock("b2", "100", rect(0, 30, 40, 20)),
	en: ocrBlock("b3", "Hello there", rect(0, 60, 100, 20)),
	ko: ocrBlock("b4", "안녕하세요", rect(0, 90, 100, 20)),
};

async function setup(
	options: {
		blocks?: readonly OcrBlock[];
		translation?: FakeTranslationOptions;
		chain?: TranslationProvider[];
		detector?: ReturnType<typeof scriptLanguageDetector>;
	} = {},
) {
	const ocr = new FakeOcrProvider({ blocks: options.blocks ?? [blocks.ja, blocks.neutral, blocks.en] });
	await ocr.init();
	const translator = new FakeTranslationProvider({ capabilities: { streaming: false }, ...options.translation });
	await translator.init();
	const chain = options.chain ?? [translator];
	for (const p of chain) await p.init();
	const pipeline = new TranslationPipeline({
		ocr: () => ocr,
		chain: () => chain,
		...(options.detector ? { detector: options.detector } : {}),
	});
	return { ocr, translator, pipeline, chain };
}

const run = async (
	pipeline: TranslationPipeline,
	over: Partial<Parameters<TranslationPipeline["run"]>[1]> = {},
): Promise<{ result: PipelineResult; events: PipelineEvent[] }> => {
	const events: PipelineEvent[] = [];
	const result = await pipeline.run(image, {
		mode: "snip",
		target: L("en"),
		sources: [],
		cache: new TranslationCache(),
		private: false,
		onEvent: (e) => events.push(e),
		...over,
	});
	return { result, events };
};

describe("pipeline: Snip event order (snip-popup.md §4, §8)", () => {
	test("started → detected → recognised → translations → progress → done", async () => {
		const { pipeline } = await setup();
		const { result, events } = await run(pipeline);
		const types = events.map((e) => e.type);
		expect(types[0]).toBe("started");
		expect(types[1]).toBe("detected");
		expect(types[2]).toBe("recognised");
		expect(types.at(-1)).toBe("done");
		expect(types.filter((t) => t === "done")).toHaveLength(1);
		expect(new Set(events.map((e) => e.runId)).size).toBe(1);

		const recognised = events.find((e) => e.type === "recognised");
		if (recognised?.type !== "recognised") throw new Error("no recognised");
		expect(recognised.blocks.map((b) => [b.id, b.cls, b.lang])).toEqual([
			["b1", "translate", "ja"],
			["b2", "neutral", null],
			["b3", "target", "en"],
		]);

		// Two sentences: first update has sentence 1 translated + sentence 2 as source.
		const updates = events.flatMap((e) => (e.type === "translation" ? [e.translation] : []));
		expect(updates).toHaveLength(2);
		expect(updates[0]).toMatchObject({ blockId: "b1", final: false });
		expect(updates[0]?.text).toBe("設定を保存しました。 [ja>en] 次へ進みます。");
		expect(updates[1]).toMatchObject({ blockId: "b1", final: true, failure: null });
		expect(updates[1]?.text).toBe("設定を保存しました。 [ja>en] 次へ進みます。 [ja>en]");

		expect(result.error).toBeNull();
		expect(result.done).toBe(1);
		expect(result.total).toBe(1);
		expect(result.cloud).toBe(false);
		expect(result.translations["b1"]?.provider?.id).toBe("fake-translation");
		const progress = events.filter((e) => e.type === "progress");
		expect(progress.at(-1)).toMatchObject({ done: 1, total: 1 });
	});

	test("the source subset turns other languages into skipped blocks; all skipped is E5", async () => {
		const { pipeline } = await setup({ blocks: [blocks.ja, blocks.ko] });
		const { result } = await run(pipeline, { sources: [L("ko")] });
		expect(result.blocks.map((b) => b.cls)).toEqual(["skip", "translate"]);
		expect(result.error).toBeNull();
		const none = await run(pipeline, { sources: [L("de")] });
		expect(none.result.blocks.map((b) => b.cls)).toEqual(["skip", "skip"]);
		expect(none.result.error?.kind).toBe("nothingToTranslate");
	});

	test("no text is E1; OCR failure is E7", async () => {
		const empty = await setup({ blocks: [] });
		expect((await run(empty.pipeline)).result.error?.kind).toBe("noText");
		const ocr = new FakeOcrProvider({ fail: () => "internal" });
		await ocr.init();
		const pipeline = new TranslationPipeline({ ocr: () => ocr, chain: () => [] });
		const { result, events } = await run(pipeline);
		expect(result.error?.kind).toBe("ocrFailed");
		expect(events.map((e) => e.type)).toEqual(["started", "done"]);
	});

	test("only neutral and target-language blocks is not an error (E6)", async () => {
		const { pipeline, translator } = await setup({ blocks: [blocks.neutral, blocks.en] });
		const { result } = await run(pipeline);
		expect(result.error).toBeNull();
		expect(translator.calls).toHaveLength(0);
	});
});

describe("pipeline: cache", () => {
	test("a second run is served from the cache, marked remembered, with no provider call", async () => {
		const { pipeline, translator } = await setup();
		const cache = new TranslationCache();
		await run(pipeline, { cache });
		expect(translator.calls).toHaveLength(1);
		expect(cache.stats().entries).toBe(2); // one per sentence
		const { result } = await run(pipeline, { cache });
		expect(translator.calls).toHaveLength(1);
		expect(result.translations["b1"]?.text).toBe("設定を保存しました。 [ja>en] 次へ進みます。 [ja>en]");
		expect(result.translations["b1"]?.provider?.remembered).toBe(true);
	});

	test("pivot routes cache per hop: a new target reuses the ja→en hop", async () => {
		const { pipeline, translator } = await setup({
			blocks: [ocrBlock("b1", "こんにちは", rect(0, 0, 50, 20))],
			translation: {
				pairs: [
					["ja", "en"],
					["en", "de"],
					["en", "fr"],
				],
				pivot: "en",
			},
		});
		const cache = new TranslationCache();
		const de = await run(pipeline, { cache, target: L("de") });
		expect(de.result.translations["b1"]).toMatchObject({ text: "こんにちは [ja>en] [en>de]", via: ["en"] });
		expect(translator.calls.map((c) => `${c.segments[0]?.from}>${c.to}`)).toEqual(["ja>en", "en>de"]);
		await run(pipeline, { cache, target: L("fr") });
		expect(translator.calls.map((c) => `${c.segments[0]?.from}>${c.to}`)).toEqual(["ja>en", "en>de", "en>fr"]);
		expect(cache.stats().entries).toBe(3);
	});

	test("Retranslate (bypassCache) calls the provider again and overwrites", async () => {
		let n = 0;
		const { pipeline, translator } = await setup({
			blocks: [ocrBlock("b1", "こんにちは", rect(0, 0, 50, 20))],
			translation: { translate: (t) => `${t} #${++n}` },
		});
		const cache = new TranslationCache();
		const first = await run(pipeline, { cache });
		const block = first.result.blocks[0];
		if (!block) throw new Error("no block");
		const again = await pipeline.translate([block], {
			target: L("en"),
			sources: [],
			cache,
			private: false,
			bypassCache: true,
		});
		expect(again.translations["b1"]?.text).toBe("こんにちは #2");
		expect(translator.calls).toHaveLength(2);
		expect((await run(pipeline, { cache })).result.translations["b1"]?.text).toBe("こんにちは #2");
	});

	test("concurrent runs share in-flight sentences (single-flight)", async () => {
		const gate = manualGate();
		const { pipeline, translator } = await setup({
			blocks: [ocrBlock("b1", "こんにちは", rect(0, 0, 50, 20))],
			translation: { gate: gate.wait },
		});
		const cache = new TranslationCache();
		const a = run(pipeline, { cache });
		const b = run(pipeline, { cache });
		await Bun.sleep(5);
		gate.open();
		const [ra, rb] = await Promise.all([a, b]);
		expect(translator.calls).toHaveLength(1);
		expect(ra.result.translations["b1"]?.text).toBe("こんにちは [ja>en]");
		expect(rb.result.translations["b1"]?.text).toBe("こんにちは [ja>en]");
	});

	test("cancelling a run rejects with cancelled, emits nothing more, and caches nothing", async () => {
		const gate = manualGate();
		const { pipeline } = await setup({ translation: { gate: gate.wait } });
		const cache = new TranslationCache();
		const controller = new AbortController();
		const events: PipelineEvent[] = [];
		const p = pipeline.run(image, {
			mode: "snip",
			target: L("en"),
			sources: [],
			cache,
			private: false,
			signal: controller.signal,
			onEvent: (e) => events.push(e),
		});
		await Bun.sleep(5);
		controller.abort();
		const error = await p.catch((e: unknown) => e);
		expect(isProviderError(error, "cancelled")).toBe(true);
		gate.open();
		await Bun.sleep(5);
		expect(events.some((e) => e.type === "done")).toBe(false);
		expect(cache.stats().entries).toBe(0);
	});

	test("errors are never cached", async () => {
		let fail = true;
		const { pipeline, translator } = await setup({
			blocks: [ocrBlock("b1", "こんにちは", rect(0, 0, 50, 20))],
			translation: { fail: () => (fail ? "timeout" : null) },
		});
		const cache = new TranslationCache();
		const first = await run(pipeline, { cache });
		expect(first.result.translations["b1"]?.failure?.kind).toBe("providerTimeout");
		expect(first.result.error?.kind).toBe("providerTimeout");
		fail = false;
		const second = await run(pipeline, { cache });
		expect(second.result.translations["b1"]?.failure).toBeNull();
		expect(translator.calls).toHaveLength(2);
	});
});

describe("pipeline: readiness and failures", () => {
	test("missing packs become pack rows; blocks wait; all waiting is E2", async () => {
		const { pipeline, translator } = await setup({
			blocks: [blocks.ja, blocks.ko],
			translation: {
				pairs: [
					["ja", "en"],
					["ko", "en"],
				],
				missing: [["ko", "en"]],
			},
		});
		const { result, events } = await run(pipeline);
		const packs = events.find((e) => e.type === "packs");
		if (packs?.type !== "packs") throw new Error("no packs event");
		expect(packs.rows).toMatchObject([{ lang: "ko", state: "missing", segmentIds: ["b4"] }]);
		const recognised = events.find((e) => e.type === "recognised");
		if (recognised?.type !== "recognised") throw new Error("no recognised");
		expect(recognised.blocks.find((b) => b.id === "b4")?.waitingForPack).toBe(true);
		expect(result.error).toBeNull();
		expect(result.total).toBe(1);
		expect(translator.calls).toHaveLength(1);
		// Pack events come before any translation.
		const firstTranslation = events.findIndex((e) => e.type === "translation");
		expect(events.findIndex((e) => e.type === "packs")).toBeLessThan(firstTranslation);

		const onlyKo = await setup({
			blocks: [blocks.ko],
			translation: { pairs: [["ko", "en"]], missing: [["ko", "en"]] },
		});
		expect((await run(onlyKo.pipeline)).result.error?.kind).toBe("packMissing");
	});

	test("an unsupported pair fails that block at once", async () => {
		const { pipeline } = await setup({ translation: { pairs: [["ko", "en"]] } });
		const { result } = await run(pipeline);
		expect(result.translations["b1"]?.failure?.kind).toBe("unsupported");
		expect(result.done).toBe(1);
	});

	test("the chain is routed in order: a ready long-tail provider serves what the first can't", async () => {
		const bergamot = new FakeTranslationProvider({ id: "bergamot", pairs: [["de", "en"]] });
		const small = new FakeTranslationProvider({ id: "small100", pairs: "any" });
		const { pipeline } = await setup({ chain: [bergamot, small] });
		const { result } = await run(pipeline);
		expect(result.translations["b1"]?.provider?.id).toBe("small100");
	});

	test("cloud provenance: result.cloud, and a remembered cloud result stays cloud", async () => {
		const cloud = new FakeTranslationProvider({ id: "cloud:fake", kind: "cloud", name: "Fake Cloud" });
		const { pipeline } = await setup({ chain: [cloud] });
		const cache = new TranslationCache();
		const first = await run(pipeline, { cache });
		expect(first.result.cloud).toBe(true);
		expect(first.result.translators).toMatchObject([{ id: "cloud:fake", kind: "cloud" }]);
		const second = await run(pipeline, { cache });
		expect(second.result.cloud).toBe(true);
		expect(second.result.translations["b1"]?.provider).toMatchObject({ kind: "cloud", remembered: true });
	});

	test("Translate these: skipped blocks with a known language are translated on request", async () => {
		const { pipeline } = await setup({ blocks: [blocks.ja, blocks.ko] });
		const { result } = await run(pipeline, { sources: [L("ja")] });
		const skipped = result.blocks.filter((b) => b.cls === "skip");
		expect(skipped.map((b) => b.id)).toEqual(["b4"]);
		const t = await pipeline.translate(skipped, {
			target: L("en"),
			sources: [L("ja")],
			cache: new TranslationCache(),
			private: false,
			includeSkipped: true,
		});
		expect(t.translations["b4"]?.text).toBe("안녕하세요 [ko>en]");
	});
});

describe("pipeline: snip capture", () => {
	const frame = (fill: number): CaptureFrame => ({
		width: 10,
		height: 10,
		data: new Uint8Array(400).fill(fill),
		rect: rect(0, 0, 10, 10),
		scale: 1,
		displayIds: [1],
		partial: false,
		sequence: 1,
		capturedAt: 0,
	});

	test("an all-black capture is E4 captureBlank; permission loss is screenAccess", async () => {
		const { pipeline, ocr } = await setup();
		const opts = { target: L("en"), sources: [], cache: new TranslationCache(), private: false };
		const blank = await pipeline.snip({ capture: async () => frame(0) }, rect(0, 0, 10, 10), opts);
		expect(blank.error?.kind).toBe("captureBlank");
		const denied = await pipeline.snip(
			{
				capture: async () => {
					throw new CaptureError("permission-denied", "no");
				},
			},
			rect(0, 0, 10, 10),
			opts,
		);
		expect(denied.error?.kind).toBe("screenAccess");
		expect(ocr.calls).toHaveLength(0);
		const ok = await pipeline.snip({ capture: async () => frame(200) }, rect(0, 0, 10, 10), opts);
		expect(ok.error).toBeNull();
		expect(ok.mode).toBe("snip");
	});
});

describe("Live session", () => {
	const live = async (opts: { private?: boolean; gate?: ReturnType<typeof manualGate> } = {}) => {
		const s = await setup({
			blocks: [ocrBlock("b1", "こんにちは", rect(0, 0, 50, 20))],
			...(opts.gate ? { translation: { gate: opts.gate.wait } } : {}),
		});
		const caches = new TranslationCaches({ now: () => 0 });
		const events: PipelineEvent[] = [];
		const session = new LivePipelineSession({
			pipeline: s.pipeline,
			caches,
			target: L("en"),
			sources: [],
			private: opts.private ?? false,
			onEvent: (e) => events.push(e),
		});
		return { ...s, caches, session, events };
	};

	test("latest frame wins: the older run resolves null and the shared sentence is translated once", async () => {
		const gate = manualGate();
		const { session, translator } = await live({ gate });
		const first = session.process(image);
		await Bun.sleep(5);
		const second = session.process(image);
		await Bun.sleep(5);
		gate.open();
		expect(await first).toBeNull();
		const result = await second;
		// Live re-ids blocks (BlockIdTracker) so they stay stable across frames.
		const id = result?.blocks[0]?.id ?? "";
		expect(id).toMatch(/^k\d+$/);
		expect(result?.translations[id]?.text).toBe("こんにちは [ja>en]");
		expect(translator.calls).toHaveLength(1);
		expect(session.last).toBe(result);
	});

	test("non-private sessions use the app cache", async () => {
		const { session, caches } = await live();
		await session.process(image);
		expect(caches.app.stats().entries).toBe(1);
		session.close();
	});

	test("Private sessions use an isolated cache dropped on close; switching Private moves caches", async () => {
		const { session, caches, translator } = await live({ private: true });
		await session.process(image);
		expect(caches.app.stats().entries).toBe(0);
		await session.process(image);
		expect(translator.calls).toHaveLength(1); // the session cache hit
		session.setPrivate(false);
		expect(session.private).toBe(false);
		await session.process(image);
		expect(caches.app.stats().entries).toBe(1);
		session.close();
		expect(await session.process(image)).toBeNull();
	});
});

describe("scriptLanguageDetector (stand-in for GLIM-49)", () => {
	const d = scriptLanguageDetector();
	const detect = (text: string, sources: LanguageCode[] = []) =>
		d.detect([ocrBlock("x", text, rect(0, 0, 1, 1))], { sources, target: L("en"), mode: "snip" });

	test.each([
		["こんにちは", { kind: "language", lang: "ja" }],
		["日本語の漢字", { kind: "language", lang: "ja" }],
		["안녕하세요", { kind: "language", lang: "ko" }],
		["สวัสดี", { kind: "language", lang: "th" }],
		["100", { kind: "neutral" }],
		["OK", { kind: "neutral" }],
		["F5", { kind: "neutral" }],
		["v1.2.3", { kind: "neutral" }],
		["Hello world", { kind: "language", lang: "en" }],
		["Привет мир", { kind: "language", lang: "ru" }],
	])("%s", (text, expected) => {
		expect(detect(text)).toMatchObject([expected]);
	});

	test("the subset decides ambiguous scripts and skips others", () => {
		expect(detect("Guten Tag", [L("de")])).toMatchObject([{ kind: "language", lang: "de" }]);
		expect(detect("こんにちは", [L("de")])).toMatchObject([{ kind: "skipped", lang: "ja" }]);
		expect(detect("漢字", [L("zh-Hant")])).toMatchObject([{ kind: "language", lang: "zh-Hant" }]);
	});

	test("OCR language hints pick the language for an ambiguous script", () => {
		const block = {
			...ocrBlock("x", "Bonjour", rect(0, 0, 1, 1)),
			languageHints: [{ lang: L("fr"), confidence: 0.8 }],
		};
		expect(d.detect([block], { sources: [], target: L("en"), mode: "snip" })).toMatchObject([
			{ kind: "language", lang: "fr" },
		]);
	});

	test("functionDetector wraps a per-text function", () => {
		const f = functionDetector((t) => (t === "x" ? null : L("ja")));
		expect(
			f.detect([ocrBlock("a", "x", rect(0, 0, 1, 1)), ocrBlock("b", "y", rect(0, 0, 1, 1))], {
				sources: [],
				target: L("en"),
				mode: "snip",
			}),
		).toMatchObject([{ kind: "skipped" }, { kind: "language", lang: "ja" }]);
	});
});
