// Bergamot provider and engine against the in-process fake Worker (no WASM, no packs):
// contract checks, routing, streaming, LRU, idle shutdown, cancellation, crash recovery and
// "never touches the network". Real packs: app/test/bergamot-real.test.ts (env-gated).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	collectTranslations,
	isProviderError,
	type LanguageCode,
	languageCode,
	parseOrDefault,
	type TranslationEvent,
	type TranslationRequest,
} from "@glimpse/core";
import { translationProviderContract } from "@glimpse/core/testing";
import {
	type BergamotProviderOptions,
	BergamotTranslationProvider,
	bergamotFactory,
	bergamotOptionsSchema,
	type DownloadablePack,
	type InstalledPack,
	staticPackSource,
} from "../src/index.ts";
import { fakeBergamotWorker } from "../src/testing.ts";

const L = languageCode;
const RUNTIME = { dir: "/runtime", revision: "bergamot-translator v0.6.0" };

const installed = (src: string, tgt: string, version = "1.0"): InstalledPack => ({
	id: `bergamot-${src}-${tgt}`,
	source: L(src),
	target: L(tgt),
	version,
	dir: `/packs/bergamot-${src}-${tgt}`,
});
const downloadable = (src: string, tgt: string, bytes = 31_000_000, version = "1.0"): DownloadablePack => ({
	id: `bergamot-${src}-${tgt}`,
	source: L(src),
	target: L(tgt),
	version,
	bytes,
});

const PACKS = [installed("ja", "en"), installed("en", "de"), installed("de", "en"), installed("en", "ja")];

function make(over: Partial<BergamotProviderOptions> & { sentenceMs?: number; crashOn?: string } = {}) {
	const fake = fakeBergamotWorker({
		...(over.sentenceMs === undefined ? {} : { sentenceMs: over.sentenceMs }),
		...(over.crashOn === undefined ? {} : { crashOn: over.crashOn }),
	});
	const packs = over.packs ?? staticPackSource({ runtime: RUNTIME, installed: PACKS, downloadable: [] });
	const provider = new BergamotTranslationProvider({ spawn: fake.spawn, idleMs: 0, ...over, packs });
	return { provider, fake, packs };
}

const req = (to: string, ...segments: [string, string][]): TranslationRequest => ({
	to: L(to),
	segments: segments.map(([from, text], i) => ({ id: `s${i}`, text, from: L(from) })),
});

async function drain(iterable: AsyncIterable<TranslationEvent>): Promise<TranslationEvent[]> {
	const out: TranslationEvent[] = [];
	for await (const e of iterable) out.push(e);
	return out;
}

describe("contract (fake worker)", () => {
	for (const c of translationProviderContract(() => make().provider, {
		pair: { from: L("ja"), to: L("de") },
		texts: ["こんにちは。", "明日の会議は午後三時に始まります。元気ですか？"],
		unsupportedPair: { from: L("xh"), to: L("de") },
	})) {
		test(c.name, c.run);
	}
	for (const c of translationProviderContract(() => make().provider, { pair: { from: L("de"), to: L("en") } })) {
		test(`direct: ${c.name}`, c.run);
	}
});

describe("BergamotTranslationProvider", () => {
	let fetchCalls = 0;
	const realFetch = globalThis.fetch;
	beforeEach(() => {
		fetchCalls = 0;
		globalThis.fetch = (() => {
			fetchCalls++;
			return Promise.reject(new Error("network disabled in tests"));
		}) as unknown as typeof fetch;
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("init without the runtime reports model-missing", async () => {
		const { provider } = make({ packs: staticPackSource({ runtime: null }) });
		const status = await provider.init();
		expect(status.state).toBe("model-missing");
		if (status.state === "model-missing") expect(status.missing[0]?.id).toBe("bergamot-runtime");
		await provider.dispose();
	});

	test("init failure in the worker is an error status, retry works", async () => {
		const bad = fakeBergamotWorker({ failInit: "boom" });
		const good = fakeBergamotWorker();
		let spawn = bad.spawn;
		const provider = new BergamotTranslationProvider({
			packs: staticPackSource({ runtime: RUNTIME, installed: PACKS }),
			spawn: () => spawn(),
			idleMs: 0,
		});
		expect((await provider.init()).state).toBe("error");
		spawn = good.spawn;
		expect((await provider.init()).state).toBe("ready");
		await provider.dispose();
	});

	test("pairSupport: direct, pivot via en, missing with sizes, unsupported, identity", async () => {
		const packs = staticPackSource({
			runtime: RUNTIME,
			installed: [installed("ja", "en")],
			downloadable: [downloadable("ja", "en"), downloadable("en", "fr", 25_000_000), downloadable("en", "de")],
		});
		const { provider } = make({ packs });
		await provider.init();
		expect(provider.pairSupport(L("ja"), L("en"))).toMatchObject({ status: "ready", hops: [{ from: "ja", to: "en" }] });
		const fr = provider.pairSupport(L("ja"), L("fr"));
		expect(fr.status).toBe("missing");
		if (fr.status === "missing") {
			expect(fr.hops.map((h) => `${h.from}>${h.to}`)).toEqual(["ja>en", "en>fr"]);
			expect(fr.missing).toEqual([{ id: "bergamot-en-fr", name: "English → French", bytes: 25_000_000 }]);
		}
		expect(provider.pairSupport(L("ko"), L("en")).status).toBe("unsupported");
		expect(provider.pairSupport(L("en"), L("en")).status).toBe("unsupported");
		// Installing the pack updates routing.
		packs.update({ installed: [installed("ja", "en"), installed("en", "fr")] });
		expect(provider.pairSupport(L("ja"), L("fr")).status).toBe("ready");
		await provider.dispose();
	});

	test("regional codes route over the base pack but keep the requested codes", async () => {
		const { provider } = make({ packs: staticPackSource({ runtime: RUNTIME, installed: [installed("pt", "en")] }) });
		await provider.init();
		const s = provider.pairSupport(L("pt-BR"), L("en"));
		expect(s).toMatchObject({ status: "ready", hops: [{ from: "pt-BR", to: "en" }] });
		await provider.dispose();
	});

	test("fingerprints change with the pack version and runtime", async () => {
		const packs = staticPackSource({ runtime: RUNTIME, installed: [installed("de", "en", "1.0")] });
		const { provider } = make({ packs });
		await provider.init();
		const a = provider.pairSupport(L("de"), L("en"));
		packs.update({ installed: [installed("de", "en", "1.1")] });
		const b = provider.pairSupport(L("de"), L("en"));
		if (a.status !== "ready" || b.status !== "ready") throw new Error("not ready");
		expect(a.hops[0]?.fingerprint.modelRevision).not.toBe(b.hops[0]?.fingerprint.modelRevision);
		expect(a.hops[0]?.fingerprint.modelRevision).toContain("bergamot-de-en@1.0");
		await provider.dispose();
	});

	test("splits segments into sentences and streams cumulative partials", async () => {
		const { provider, fake } = make();
		await provider.init();
		const events = await drain(provider.translate(req("en", ["ja", "明日です。元気ですか？"], ["de", "Hallo."])));
		expect(events.map((e) => `${e.type}:${e.id}`)).toEqual(["partial:s0", "done:s0", "done:s1"]);
		expect(events[0]).toMatchObject({ text: "明日です。 [ja>en]" });
		expect(events[1]).toMatchObject({ translation: { text: "明日です。 [ja>en] 元気ですか？ [ja>en]" } });
		const translates = fake.log.messages.filter((m) => m.type === "translate");
		expect(translates).toHaveLength(2); // one Worker call per route
		expect(fetchCalls).toBe(0);
		await provider.dispose();
	});

	test("pivot routes run both packs in one call and report via [en]", async () => {
		const { provider, fake } = make();
		await provider.init();
		const results = await collectTranslations(provider, req("de", ["ja", "こんにちは。"]));
		const r = results.get("s0");
		expect(r?.ok && r.translation.text).toBe("こんにちは。 [ja>en] [en>de]");
		expect(r?.ok && r.translation.via).toEqual([L("en")]);
		const t = fake.log.messages.find((m) => m.type === "translate");
		expect(t?.type === "translate" && t.route).toEqual(["bergamot-ja-en@1.0", "bergamot-en-de@1.0"]);
		await provider.dispose();
	});

	test("missing pack and unsupported pair are per-segment errors; others translate", async () => {
		const packs = staticPackSource({
			runtime: RUNTIME,
			installed: [installed("de", "en")],
			downloadable: [downloadable("ja", "en")],
		});
		const { provider } = make({ packs });
		await provider.init();
		const results = await collectTranslations(provider, req("en", ["ja", "はい。"], ["de", "Ja."], ["xh", "Ewe."]));
		expect(results.get("s0")).toMatchObject({ ok: false, error: { code: "model-missing", providerId: "bergamot" } });
		expect(results.get("s1")).toMatchObject({ ok: true });
		expect(results.get("s2")).toMatchObject({ ok: false, error: { code: "unsupported-language" } });
		expect(fetchCalls).toBe(0);
		await provider.dispose();
	});

	test("whitespace-only segments are done with empty text without a Worker call", async () => {
		const { provider, fake } = make();
		await provider.init();
		const events = await drain(provider.translate(req("en", ["de", "  \n "])));
		expect(events).toMatchObject([{ type: "done", translation: { text: "" } }]);
		expect(fake.log.messages.some((m) => m.type === "translate")).toBe(false);
		await provider.dispose();
	});

	test("LRU keeps at most maxLoadedPacks loaded, never evicting the route in use", async () => {
		const packs = staticPackSource({
			runtime: RUNTIME,
			installed: [installed("ja", "en"), installed("en", "de"), installed("de", "en"), installed("en", "fr")],
		});
		const { provider, fake } = make({ packs, maxLoadedPacks: 2 });
		await provider.init();
		await collectTranslations(provider, req("de", ["ja", "一。"])); // ja-en + en-de
		expect(provider.loadedPacks).toEqual(["bergamot-ja-en@1.0", "bergamot-en-de@1.0"]);
		await collectTranslations(provider, req("en", ["de", "Eins."])); // evicts ja-en
		expect(provider.loadedPacks).toEqual(["bergamot-en-de@1.0", "bergamot-de-en@1.0"]);
		await collectTranslations(provider, req("fr", ["de", "Zwei."])); // de-en + en-fr, evicts en-de
		expect(provider.loadedPacks).toEqual(["bergamot-de-en@1.0", "bergamot-en-fr@1.0"]);
		expect(fake.log.peakLoaded).toBe(2);
		await provider.dispose();
	});

	test("prepare/warmup loads and warms installed routes ahead of time", async () => {
		const { provider, fake } = make({ warmPairs: [{ from: L("ja"), to: L("de") }] });
		await provider.init();
		await provider.warmup();
		expect(provider.loadedPacks).toEqual(["bergamot-ja-en@1.0", "bergamot-en-de@1.0"]);
		expect(fake.log.messages.filter((m) => m.type === "load")).toHaveLength(2);
		await collectTranslations(provider, req("de", ["ja", "一。"]));
		expect(fake.log.messages.filter((m) => m.type === "load")).toHaveLength(2); // no reload
		await provider.dispose();
	});

	test("idle Worker is terminated and transparently restarted", async () => {
		const { provider, fake } = make({ idleMs: 20 });
		await provider.init();
		await collectTranslations(provider, req("en", ["de", "Hallo."]));
		await new Promise((r) => setTimeout(r, 60));
		expect(fake.log.terminated).toBe(1);
		expect(provider.loadedPacks).toEqual([]);
		const again = await collectTranslations(provider, req("en", ["de", "Hallo."]));
		expect(again.get("s0")?.ok).toBe(true);
		expect(fake.log.spawned).toBe(2);
		await provider.dispose();
	});

	test("abort mid-request rejects promptly and cancels the Worker job", async () => {
		const { provider, fake } = make({ sentenceMs: 30 });
		await provider.init();
		const controller = new AbortController();
		const text = Array.from({ length: 20 }, (_, i) => `Satz ${i}.`).join(" ");
		const it = provider.translate(req("en", ["de", text]), { signal: controller.signal })[Symbol.asyncIterator]();
		const first = await it.next();
		expect(first.done).toBe(false);
		const t0 = performance.now();
		controller.abort();
		const err = await it.next().catch((e: unknown) => e);
		expect(isProviderError(err, "cancelled")).toBe(true);
		expect(performance.now() - t0).toBeLessThan(25);
		expect(fake.log.messages.some((m) => m.type === "cancel")).toBe(true);
		// The provider stays usable.
		const results = await collectTranslations(provider, req("en", ["de", "Hallo."]));
		expect(results.get("s0")?.ok).toBe(true);
		await provider.dispose();
	});

	test("a Worker crash fails the unfinished segments and the next request respawns", async () => {
		const { provider, fake } = make({ crashOn: "KABOOM" });
		await provider.init();
		const results = await collectTranslations(provider, req("en", ["de", "Gut."], ["de", "KABOOM."]));
		expect(results.get("s0")?.ok).toBe(true);
		expect(results.get("s1")).toMatchObject({ ok: false, error: { code: "internal" } });
		const after = await collectTranslations(provider, req("en", ["de", "Wieder gut."]));
		expect(after.get("s0")?.ok).toBe(true);
		expect(fake.log.spawned).toBe(2);
		await provider.dispose();
	});

	test("concurrent requests are serialised and both complete", async () => {
		const { provider } = make({ sentenceMs: 5 });
		await provider.init();
		const [a, b] = await Promise.all([
			collectTranslations(provider, req("en", ["de", "Eins. Zwei."])),
			collectTranslations(provider, req("de", ["ja", "一。二。"])),
		]);
		expect(a.get("s0")?.ok && a.get("s0")).toBeTruthy();
		expect(b.get("s0")).toMatchObject({ ok: true, translation: { text: "一。 [ja>en] [en>de] 二。 [ja>en] [en>de]" } });
		await provider.dispose();
	});
});

describe("bergamotFactory", () => {
	test("defaults and create", async () => {
		const factory = bergamotFactory();
		expect(factory.info.id).toBe("bergamot");
		expect(factory.defaultRank).toBe(0);
		expect(parseOrDefault(bergamotOptionsSchema, {}).value).toEqual({ maxLoadedPacks: 4, idleSeconds: 300 });
		expect(parseOrDefault(bergamotOptionsSchema, { maxLoadedPacks: 1 }).issues).toHaveLength(1);
		const fake = fakeBergamotWorker();
		const provider = factory.create(
			{ maxLoadedPacks: 2, idleSeconds: 0 },
			{ bergamot: { packs: staticPackSource({ runtime: RUNTIME, installed: PACKS }), spawn: fake.spawn } },
		);
		expect((await provider.init()).state).toBe("ready");
		const to: LanguageCode = L("en");
		expect(provider.pairSupport(L("ja"), to).status).toBe("ready");
		await provider.dispose();
	});
});
