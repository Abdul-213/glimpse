// The Bergamot provider on the real WASM runtime and real Firefox Translations packs, in
// its real Bun Worker. Skipped unless GLIMPSE_REAL_PACKS=1, so CI never downloads ~100 MB:
//   GLIMPSE_REAL_PACKS=1 bun test app/test/bergamot-real.test.ts
// Packs and the runtime install once into ~/.cache/glimpse/test-installs (or
// $GLIMPSE_MODEL_CACHE/../test-installs) through the real model manager, then are reused.
// Prints latency per sentence and memory; compare with spikes/inference/FINDINGS.md.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collectTranslations, languageCode, type TranslationRequest } from "@glimpse/core";
import { translationProviderContract } from "@glimpse/core/testing";
import { BergamotTranslationProvider } from "@glimpse/providers/translation/bergamot";
import { defaultCacheDir, loadManifest } from "../scripts/model-cache.ts";
import { loadBergamotCatalogue, manifestInstallable, packInstallable } from "../src/bun/services/models/catalogue.ts";
import { ModelManager } from "../src/bun/services/models/model-manager.ts";
import { ModelManagerPackSource, RUNTIME_MODEL_ID } from "../src/bun/services/translation/bergamot-packs.ts";

const enabled = process.env["GLIMPSE_REAL_PACKS"] === "1";
const L = languageCode;
const PACKS = ["bergamot-ja-en", "bergamot-en-de", "bergamot-de-en"];

let manager: ModelManager;
let packs: ModelManagerPackSource;

const make = () => new BergamotTranslationProvider({ packs, idleMs: 0, maxLoadedPacks: 3 });

beforeAll(async () => {
	if (!enabled) return;
	const root = join(defaultCacheDir(), "..", "test-installs");
	manager = new ModelManager({ root });
	await manager.scan();
	const runtime = loadManifest().models.find((m) => m.id === RUNTIME_MODEL_ID);
	if (!runtime) throw new Error("manifest has no bergamot-runtime");
	await manager.install(manifestInstallable(runtime));
	const catalogue = await loadBergamotCatalogue({ cacheFile: join(root, ".catalogue.json") });
	for (const id of PACKS) {
		const pack = catalogue.packs.find((p) => p.id === id);
		if (!pack) throw new Error(`catalogue has no ${id}`);
		const state = await manager.install(packInstallable(pack));
		if (state.status !== "installed") throw new Error(`${id}: ${JSON.stringify(state)}`);
	}
	packs = new ModelManagerPackSource(manager);
	packs.setCatalogue(catalogue.packs);
}, 600_000);

afterAll(() => packs?.dispose());

describe.skipIf(!enabled)("Bergamot on real packs", () => {
	for (const c of translationProviderContract(make, {
		pair: { from: L("ja"), to: L("de") },
		texts: ["明日の会議は午後三時に始まります。", "請求書を保存しました。"],
		unsupportedPair: { from: L("tlh"), to: L("de") },
	})) {
		test(`contract ja→de (pivot): ${c.name}`, c.run, 120_000);
	}

	test("translates, streams sentences, makes no network calls; latency and memory", async () => {
		const realFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = (() => {
			fetchCalls++;
			return Promise.reject(new Error("offline"));
		}) as unknown as typeof fetch;
		const provider = make();
		try {
			const t0 = performance.now();
			expect((await provider.init()).state).toBe("ready");
			const initMs = performance.now() - t0;
			const t1 = performance.now();
			await provider.prepare(L("ja"), L("en"));
			const prepareMs = performance.now() - t1;

			const one = async (from: string, to: string, text: string) => {
				const r = await collectTranslations(provider, { to: L(to), segments: [{ id: "x", text, from: L(from) }] });
				const o = r.get("x");
				if (!o?.ok) throw new Error(`failed: ${JSON.stringify(o)}`);
				return o.translation.text;
			};
			const ja = "明日の会議は午後三時に始まります。";
			expect(await one("ja", "en", ja)).toMatch(/meeting/i);
			expect(await one("de", "en", "Die Datei konnte nicht gespeichert werden.")).toMatch(/file/i);
			expect(await one("ja", "de", ja)).toMatch(/Treffen|Sitzung|Besprechung/);

			const time = async (from: string, to: string, text: string, n = 10) => {
				const ms: number[] = [];
				for (let i = 0; i < n; i++) {
					const s = performance.now();
					await one(from, to, text);
					ms.push(performance.now() - s);
				}
				ms.sort((a, b) => a - b);
				return { p50: ms[Math.floor(n / 2)] ?? 0, min: ms[0] ?? 0 };
			};
			const jaEn = await time("ja", "en", ja);
			const deEn = await time("de", "en", "Die Datei konnte nicht gespeichert werden.");
			const jaDe = await time("ja", "de", ja);

			// Streaming: a three-sentence block gives two partials then done.
			const request: TranslationRequest = {
				to: L("en"),
				segments: [{ id: "b", text: "設定を保存しました。次へ進みます。ありがとう。", from: L("ja") }],
			};
			const kinds: string[] = [];
			for await (const e of provider.translate(request)) kinds.push(e.type);
			expect(kinds).toEqual(["partial", "partial", "done"]);

			// Five-sentence batch, as in the spike's Snip case.
			const five: TranslationRequest = {
				to: L("en"),
				segments: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, text: ja, from: L("ja") })),
			};
			const b0 = performance.now();
			await collectTranslations(provider, five);
			const batch5 = performance.now() - b0;

			const stats = await provider.engine?.stats();
			const rss = process.memoryUsage().rss;
			console.log(
				[
					`bergamot real: init ${initMs.toFixed(0)} ms, load+warm ja-en ${prepareMs.toFixed(0)} ms`,
					`  per sentence warm p50 (min): ja→en ${jaEn.p50.toFixed(0)} (${jaEn.min.toFixed(0)}) ms, de→en ${deEn.p50.toFixed(0)} (${deEn.min.toFixed(0)}) ms, ja→en→de ${jaDe.p50.toFixed(0)} (${jaDe.min.toFixed(0)}) ms`,
					`  batch of 5 ja→en: ${batch5.toFixed(0)} ms`,
					`  memory: process RSS ${(rss / 1e6).toFixed(0)} MB, WASM heap ${((stats?.wasmHeapBytes ?? 0) / 1e6).toFixed(0)} MB, loaded ${stats?.loaded.join(", ")}`,
				].join("\n"),
			);
			expect(jaEn.p50).toBeLessThan(1500);
			expect(fetchCalls).toBe(0);
		} finally {
			globalThis.fetch = realFetch;
			await provider.dispose();
		}
	}, 300_000);

	test("LRU: with maxLoadedPacks 2 a third pack evicts the oldest; idle stop frees the Worker", async () => {
		const provider = new BergamotTranslationProvider({ packs, idleMs: 200, maxLoadedPacks: 2 });
		try {
			await provider.init();
			await collectTranslations(provider, { to: L("de"), segments: [{ id: "a", text: "はい。", from: L("ja") }] });
			await collectTranslations(provider, { to: L("en"), segments: [{ id: "b", text: "Ja.", from: L("de") }] });
			expect(provider.loadedPacks).toHaveLength(2);
			expect(provider.loadedPacks.some((k) => k.startsWith("bergamot-de-en@"))).toBe(true);
			await Bun.sleep(400);
			expect(provider.engine?.running).toBe(false);
			const again = await collectTranslations(provider, {
				to: L("en"),
				segments: [{ id: "c", text: "Danke.", from: L("de") }],
			});
			expect(again.get("c")?.ok).toBe(true);
		} finally {
			await provider.dispose();
		}
	}, 120_000);
});
