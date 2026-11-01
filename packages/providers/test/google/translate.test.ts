import { describe, expect, test } from "bun:test";
import {
	collectTranslations,
	languageCode,
	ProviderRegistry,
	parseOrDefault,
	type TranslationEvent,
	type TranslationRequest,
} from "@glimpse/core";
import { type ContractCheck, MemorySecretStore, translationProviderContract } from "@glimpse/core/testing";
import { GOOGLE_SECRET_ID } from "../../src/google/common.ts";
import { type FakeCall, FakeFetch, type FakeHandler } from "../../src/google/fake-fetch.ts";
import { googleTranslateFactory } from "../../src/translation/google-v2/factory.ts";
import { GoogleLanguageTable, parseLanguagesReply } from "../../src/translation/google-v2/languages.ts";
import {
	GoogleTranslateProvider,
	LANGUAGES_V2_ENDPOINT,
	parseTranslateReply,
	TRANSLATE_V2_ENDPOINT,
} from "../../src/translation/google-v2/provider.ts";
import { errorReply, fixtureJson, TEST_KEY } from "./helpers.ts";

const L = languageCode;

/** Answers like v2 does: one translatedText per `q`, in order. Tags them so tests can see the pair. */
const echo: FakeHandler = (call: FakeCall) => {
	const body = call.body as { q: string[]; source: string; target: string };
	return {
		json: { data: { translations: body.q.map((q) => ({ translatedText: `${q} [${body.source}>${body.target}]` })) } },
	};
};

function setup(translate: FakeHandler = echo, key: string | null = TEST_KEY) {
	const fake = new FakeFetch()
		.on("POST", TRANSLATE_V2_ENDPOINT, translate)
		.on("GET", LANGUAGES_V2_ENDPOINT, { json: fixtureJson("translate-languages.json") });
	const secrets = new MemorySecretStore(key ? { [GOOGLE_SECRET_ID]: key } : {});
	const make = (options = {}) => new GoogleTranslateProvider(options, { google: { secrets, fetch: fake.fetch } });
	return { fake, secrets, make };
}

async function drain(iterable: AsyncIterable<TranslationEvent>): Promise<TranslationEvent[]> {
	const out: TranslationEvent[] = [];
	for await (const e of iterable) out.push(e);
	return out;
}

const translateCalls = (fake: FakeFetch) => fake.calls.filter((c) => c.url === TRANSLATE_V2_ENDPOINT);

describe("Google Translation v2: core translation provider contract (recorded replies)", () => {
	const { make } = setup();
	const checks: ContractCheck[] = translationProviderContract(() => make(), {
		pair: { from: L("ja"), to: L("en") },
		texts: ["設定を保存しました。", "このアイテムを使用しますか？", "明日の会議は午後三時に始まります。"],
		unsupportedPair: { from: L("tlh"), to: L("en") },
	});
	for (const c of checks) test(c.name, c.run);
});

describe("Google Translation v2: requests", () => {
	test("one POST per source language: q[], source always set, format text, model nmt", async () => {
		const { fake, make } = setup();
		const p = make();
		await p.init();
		const request: TranslationRequest = {
			to: L("en"),
			segments: [
				{ id: "a", text: "設定を保存しました。", from: L("ja") },
				{ id: "b", text: "Guten Morgen", from: L("de") },
				{ id: "c", text: "次へ", from: L("ja") },
				{ id: "d", text: "שלום", from: L("he") },
				{ id: "e", text: "你好", from: L("zh-Hant") },
			],
		};
		const results = await collectTranslations(p, request);
		const calls = translateCalls(fake);
		expect(calls.map((c) => c.body)).toEqual([
			{ q: ["設定を保存しました。", "次へ"], source: "ja", target: "en", format: "text", model: "nmt" },
			{ q: ["Guten Morgen"], source: "de", target: "en", format: "text", model: "nmt" },
			{ q: ["שלום"], source: "iw", target: "en", format: "text", model: "nmt" },
			{ q: ["你好"], source: "zh-TW", target: "en", format: "text", model: "nmt" },
		]);
		for (const c of calls) {
			expect(c.headers["x-goog-api-key"]).toBe(TEST_KEY);
			expect(c.url).not.toContain(TEST_KEY);
		}
		const c = results.get("c");
		expect(c?.ok && c.translation).toMatchObject({
			text: "次へ [ja>en]",
			from: "ja",
			to: "en",
			via: [],
			provider: { id: "cloud:google-translate-v2", kind: "cloud", name: "Google Cloud Translation" },
		});
	});

	test("the recorded reply maps onto the segments in order", async () => {
		const { make } = setup({ json: fixtureJson("translate-ja-en.json") });
		const p = make();
		await p.init();
		const texts = ["設定を保存しました。", "このアイテムを使用しますか？", "明日の会議は午後三時に始まります。"];
		const results = await collectTranslations(p, {
			to: L("en"),
			segments: texts.map((text, i) => ({ id: `s${i}`, text, from: L("ja") })),
		});
		const out = [0, 1, 2].map((i) => {
			const r = results.get(`s${i}`);
			return r?.ok ? r.translation.text : null;
		});
		expect(out).toEqual(["Settings saved.", "Do you want to use this item?", "The meeting tomorrow starts at 3 p.m."]);
	});

	test("large batches split at 128 segments", async () => {
		const { fake, make } = setup();
		const p = make();
		await p.init();
		const segments = Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, text: `line ${i}`, from: L("de") }));
		const results = await collectTranslations(p, { to: L("en"), segments });
		expect(translateCalls(fake).map((c) => (c.body as { q: string[] }).q.length)).toEqual([128, 128, 44]);
		expect([...results.values()].every((r) => r.ok)).toBe(true);
	});

	test("a reply with the wrong number of translations fails that batch, not the stream", async () => {
		const { make } = setup({ json: { data: { translations: [{ translatedText: "only one" }] } } });
		const p = make();
		await p.init();
		const results = await collectTranslations(p, {
			to: L("en"),
			segments: [
				{ id: "a", text: "eins", from: L("de") },
				{ id: "b", text: "zwei", from: L("de") },
			],
		});
		expect(results.get("a")).toMatchObject({ ok: false, error: { code: "network" } });
	});
});

describe("Google Translation v2: languages", () => {
	test("pairs follow the catalogue snapshot until refreshed", async () => {
		const { make } = setup();
		const p = make();
		expect(p.pairSupport(L("ja"), L("en")).status).toBe("unsupported"); // before init
		await p.init();
		expect(p.languageSource).toBe("snapshot");
		expect(p.pairSupport(L("ja"), L("en")).status).toBe("ready");
		expect(p.pairSupport(L("en"), L("en")).status).toBe("unsupported");
		expect(p.pairSupport(L("tlh"), L("en")).status).toBe("unsupported");
	});

	test("warmup refreshes from GET /v2/languages, keeping the catalogue's spellings", async () => {
		const { fake, make } = setup();
		const p = make();
		await p.init();
		await p.warmup();
		expect(p.languageSource).toBe("live");
		const get = fake.calls.find((c) => c.method === "GET");
		expect(get?.url).toBe(LANGUAGES_V2_ENDPOINT);
		expect(get?.body).toBeNull();
		// Meiteilon is in the live list but not the catalogue's Google column.
		expect(p.pairSupport(L("mni-Mtei"), L("en")).status).toBe("ready");
		const sources = p.capabilities.languages.sources;
		expect(sources === "any" ? [] : sources).toContain(L("mni-Mtei"));
		// `iw` and `he` are both listed; requests keep using the catalogue's `iw`.
		await collectTranslations(p, { to: L("en"), segments: [{ id: "h", text: "שלום", from: L("he") }] });
		expect((translateCalls(fake)[0]?.body as { source: string } | undefined)?.source).toBe("iw");
	});

	test("a failed refresh keeps the snapshot and doesn't fail warmup", async () => {
		const fake = new FakeFetch().on("GET", LANGUAGES_V2_ENDPOINT, errorReply("service-disabled"));
		const secrets = new MemorySecretStore({ [GOOGLE_SECRET_ID]: TEST_KEY });
		const p = new GoogleTranslateProvider({}, { google: { secrets, fetch: fake.fetch } });
		await p.init();
		await p.warmup();
		expect(p.languageSource).toBe("snapshot");
		await expect(p.refreshLanguages()).rejects.toMatchObject({ code: "invalid-key", problem: "api-disabled" });
	});

	test("refresh can be turned off", async () => {
		const { fake, make } = setup();
		const p = make({ refreshLanguages: false });
		await p.init();
		await p.warmup();
		expect(fake.calls).toHaveLength(0);
	});

	test("parsing", () => {
		expect(parseLanguagesReply({ data: { languages: [{ language: "de" }, { name: "x" }, 7] } })).toEqual(["de"]);
		expect(parseLanguagesReply(null)).toEqual([]);
		const table = GoogleLanguageTable.fromCodes(["zh", "zh-CN", "zh-TW", "he", "iw", "jv", "jw"]);
		expect(table.get(L("zh-Hans"))).toBe("zh-CN");
		expect(table.get(L("zh-Hant"))).toBe("zh-TW");
		expect(table.get(L("he"))).toBe("iw");
		expect(table.get(L("jv"))).toBe("jw");
		expect(parseTranslateReply({ data: { translations: [{ translatedText: "a" }] } })).toEqual(["a"]);
		expect(parseTranslateReply({ data: {} })).toBeNull();
	});
});

describe("Google Translation v2: keys and errors become per-segment events", () => {
	const request: TranslationRequest = {
		to: L("en"),
		segments: [
			{ id: "a", text: "eins", from: L("de") },
			{ id: "b", text: "un", from: L("fr") },
		],
	};

	test("no key: init ends in needs-key; translate errors needs-key without calling Google", async () => {
		const { fake, make } = setup(echo, null);
		const p = make();
		expect((await p.init()).state).toBe("needs-key");
		const events = await drain(p.translate(request));
		expect(events.map((e) => e.type === "error" && e.error.code)).toEqual(["needs-key", "needs-key"]);
		expect(fake.calls).toHaveLength(0);
	});

	test("key removed while ready: needs-key per segment, status follows", async () => {
		const { fake, make, secrets } = setup();
		const p = make();
		await p.init();
		await secrets.delete(GOOGLE_SECRET_ID);
		const events = await drain(p.translate(request));
		expect(events.every((e) => e.type === "error" && e.error.code === "needs-key")).toBe(true);
		expect(p.status.state).toBe("needs-key");
		expect(fake.calls).toHaveLength(0);
	});

	test("API not enabled: one request, then every segment errors invalid-key (no retry storm)", async () => {
		const { fake, make } = setup(errorReply("service-disabled"));
		const p = make();
		await p.init();
		const events = await drain(p.translate(request));
		expect(events.map((e) => e.type === "error" && e.error.code)).toEqual(["invalid-key", "invalid-key"]);
		expect(events[0]?.type === "error" && events[0].error.message).toContain("SERVICE_DISABLED");
		expect(translateCalls(fake)).toHaveLength(1);
	});

	test("quota, rate limit, offline, 5xx", async () => {
		for (const [reply, code] of [
			[errorReply("quota-daily"), "quota-exceeded"],
			[errorReply("rate-limited"), "rate-limited"],
			[{ network: "offline" }, "offline"],
			[errorReply("unavailable"), "network"],
		] as const) {
			const { make } = setup(reply);
			const p = make();
			await p.init();
			const events = await drain(p.translate(request));
			expect(events.map((e) => e.type === "error" && e.error.code)).toEqual([code, code]);
		}
	});

	test("a transient 5xx on one batch doesn't stop the next", async () => {
		let n = 0;
		const { make } = setup((call) => (n++ === 0 ? errorReply("unavailable") : echo(call)));
		const p = make();
		await p.init();
		const events = await drain(p.translate(request));
		expect(events.map((e) => e.type)).toEqual(["error", "done"]);
	});

	test("cancelling mid-request rejects cancelled and yields nothing more", async () => {
		const { make } = setup({ hang: true });
		const p = make();
		await p.init();
		const controller = new AbortController();
		const events: TranslationEvent[] = [];
		const run = (async () => {
			for await (const e of p.translate(request, { signal: controller.signal })) events.push(e);
		})();
		setTimeout(() => controller.abort(), 5);
		await expect(run).rejects.toMatchObject({ code: "cancelled" });
		expect(events).toHaveLength(0);
	});
});

describe("Google Translation v2: registry", () => {
	test("opt-in only, and never after a local translator in the chain", () => {
		const registry = new ProviderRegistry<{ google: { secrets: MemorySecretStore } }>();
		registry.register(googleTranslateFactory());
		registry.register({
			info: { id: "bergamot", name: "Local", kind: "local", task: "translation", vendor: null },
			capabilities: { ...googleTranslateFactory().capabilities, kind: "local", needsNetwork: false, secretId: null },
			defaultRank: 0,
			options: googleTranslateFactory().options,
			create: () => {
				throw new Error("unused");
			},
		});
		expect(registry.defaultConfig().translation).toEqual(["bergamot"]);
		const after = parseOrDefault(registry.configSchema(), { translation: ["bergamot", "cloud:google-translate-v2"] });
		expect(after.value.translation).toEqual(["bergamot"]);
		const first = parseOrDefault(registry.configSchema(), { translation: ["cloud:google-translate-v2", "bergamot"] });
		expect(first.value.translation).toEqual(["cloud:google-translate-v2", "bergamot"]);
	});
});
