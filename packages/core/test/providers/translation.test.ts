import { describe, expect, test } from "bun:test";
import {
	chunkSegments,
	collectTranslations,
	isProviderError,
	languageCode,
	type TranslationEvent,
	type TranslationProvider,
} from "../../src/index.ts";
import {
	type ContractCheck,
	FakeTranslationProvider,
	manualGate,
	translationProviderContract,
} from "../../src/testing/index.ts";

const ja = languageCode("ja");
const en = languageCode("en");
const de = languageCode("de");
const th = languageCode("th");

const runAll = (checks: ContractCheck[]) => {
	for (const c of checks) test(c.name, c.run);
};

describe("translation contract: fake, direct, streaming", () => {
	runAll(translationProviderContract(() => new FakeTranslationProvider(), { pair: { from: ja, to: en } }));
});

describe("translation contract: fake, English pivot, not streaming, with limits", () => {
	runAll(
		translationProviderContract(
			() =>
				new FakeTranslationProvider({
					id: "bergamot-fake",
					pairs: [
						["ja", "en"],
						["en", "de"],
					],
					pivot: "en",
					capabilities: { streaming: false, maxCharsPerSegment: 200 },
				}),
			{ pair: { from: ja, to: de }, unsupportedPair: { from: th, to: en } },
		),
	);
});

describe("translation contract: fake cloud provider", () => {
	runAll(
		translationProviderContract(() => new FakeTranslationProvider({ id: "cloud:fake", kind: "cloud" }), {
			pair: { from: ja, to: en },
		}),
	);
});

describe("contract catches broken providers", () => {
	test("a provider that drops a segment fails the terminal-event check", async () => {
		class Dropping extends FakeTranslationProvider {
			override async *translate(...args: Parameters<TranslationProvider["translate"]>) {
				let first = true;
				for await (const event of super.translate(...args)) {
					if (event.type !== "partial" && first) {
						first = false;
						continue;
					}
					yield event;
				}
			}
		}
		const checks = translationProviderContract(() => new Dropping(), { pair: { from: ja, to: en } });
		const terminal = checks.find((c) => c.name.startsWith("translate: exactly one terminal"));
		expect(terminal).toBeDefined();
		await expect(terminal?.run()).rejects.toThrow(/got no done\/error event/);
	});
});

describe("FakeTranslationProvider behaviour", () => {
	test("pivots through English and reports both hops", async () => {
		const p = new FakeTranslationProvider({
			pairs: [
				["ja", "en"],
				["en", "de"],
			],
			pivot: "en",
		});
		await p.init();
		const support = p.pairSupport(ja, de);
		expect(support.status).toBe("ready");
		if (support.status !== "ready") return;
		expect(support.hops.map((h) => `${h.from}>${h.to}`)).toEqual(["ja>en", "en>de"]);
		const out = await collectTranslations(p, { to: de, segments: [{ id: "a", text: "こんにちは", from: ja }] });
		const a = out.get("a");
		expect(a?.ok).toBe(true);
		if (!a?.ok) return;
		expect(a.translation.text).toBe("こんにちは [ja>en] [en>de]");
		expect(a.translation.via).toEqual([en]);
		expect(a.translation.provider.modelRevision).toBe("fake-1:ja-en+fake-1:en-de");
	});

	test("missing packs are reported per pair and per segment", async () => {
		const p = new FakeTranslationProvider({
			pairs: [
				["th", "en"],
				["ja", "en"],
			],
			missing: [["th", "en"]],
		});
		await p.init();
		const support = p.pairSupport(th, en);
		expect(support.status).toBe("missing");
		if (support.status === "missing") expect(support.missing[0]?.id).toBe("fake-translation:th-en");
		const out = await collectTranslations(p, {
			to: en,
			segments: [
				{ id: "t", text: "สวัสดี", from: th },
				{ id: "j", text: "はい", from: ja },
			],
		});
		const t = out.get("t");
		expect(t?.ok === false && t.error.code).toBe("model-missing");
		expect(out.get("j")?.ok).toBe(true);
	});

	test("streams cumulative partials before done", async () => {
		const p = new FakeTranslationProvider({ translate: (text) => text.toUpperCase() });
		await p.init();
		const events: TranslationEvent[] = [];
		for await (const e of p.translate({ to: en, segments: [{ id: "a", text: "one two three", from: ja }] })) {
			events.push(e);
		}
		expect(
			events.map((e) => (e.type === "done" ? `done:${e.translation.text}` : `${e.type}:${"text" in e ? e.text : ""}`)),
		).toEqual(["partial:ONE ", "partial:ONE TWO ", "done:ONE TWO THREE"]);
	});

	test("aborting while a segment is held rejects cancelled promptly", async () => {
		const gate = manualGate();
		const p = new FakeTranslationProvider({ gate: gate.wait });
		await p.init();
		const controller = new AbortController();
		const run = collectTranslations(
			p,
			{ to: en, segments: [{ id: "a", text: "x", from: ja }] },
			{
				signal: controller.signal,
			},
		);
		await Promise.resolve();
		controller.abort();
		const error = await run.catch((e: unknown) => e);
		expect(isProviderError(error, "cancelled")).toBe(true);
	});

	test("scripted failures become error events and other segments still finish", async () => {
		const p = new FakeTranslationProvider({ fail: (s) => (s.id === "bad" ? "rate-limited" : null) });
		await p.init();
		const out = await collectTranslations(p, {
			to: en,
			segments: [
				{ id: "bad", text: "x", from: ja },
				{ id: "ok", text: "y", from: ja },
			],
		});
		const bad = out.get("bad");
		expect(bad?.ok === false && bad.error).toMatchObject({ code: "rate-limited", retryable: true });
		expect(out.get("ok")?.ok).toBe(true);
	});

	test("init can end in model-missing and be retried", async () => {
		let installed = false;
		const p = new FakeTranslationProvider({
			initStatus: () =>
				installed
					? { state: "ready" }
					: { state: "model-missing", missing: [{ id: "bergamot:ja-en", name: "Japanese → English", bytes: 31e6 }] },
		});
		expect((await p.init()).state).toBe("model-missing");
		installed = true;
		expect((await p.init()).state).toBe("ready");
	});
});

describe("chunkSegments", () => {
	const seg = (id: string, n: number) => ({ id, text: "x".repeat(n) });
	test("respects segment and character limits, keeping order", () => {
		const batches = chunkSegments([seg("a", 3), seg("b", 3), seg("c", 3), seg("d", 9)], {
			maxSegmentsPerRequest: 2,
			maxCharsPerRequest: 7,
		});
		expect(batches.map((b) => b.map((s) => s.id))).toEqual([["a", "b"], ["c"], ["d"]]);
	});
	test("no limits means one batch", () => {
		expect(
			chunkSegments([seg("a", 1), seg("b", 1)], { maxSegmentsPerRequest: null, maxCharsPerRequest: null }),
		).toHaveLength(1);
		expect(chunkSegments([], { maxSegmentsPerRequest: 1, maxCharsPerRequest: 1 })).toEqual([]);
	});
});
