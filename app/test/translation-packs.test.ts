// GLIM-57 end to end over the real model manager and the Bergamot provider (fake Worker):
// installed packs translate with no network, a missing pack is a download prompt (or
// "offline"), the download only happens on request, and the blocks translate once it lands.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BergamotPack, collectTranslations, languageCode } from "@glimpse/core";
import { fakeBergamotWorker } from "@glimpse/providers/testing";
import { BergamotTranslationProvider } from "@glimpse/providers/translation/bergamot";
import { ModelManager } from "../src/bun/services/models/model-manager.ts";
import { ModelManagerPackSource } from "../src/bun/services/translation/bergamot-packs.ts";
import { packChangedMessage, TranslationPacks } from "../src/bun/services/translation/translation-packs.ts";
import { bytes, type FakeServer, plainFile, startFakeServer } from "./fake-model-server.ts";

const L = languageCode;
const realFetch = globalThis.fetch;
let server: FakeServer;
let dir: string;
let fetchCalls: string[] = [];

beforeAll(() => {
	server = startFakeServer();
});
afterAll(() => server.stop());

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "glimpse-packs-"));
	fetchCalls = [];
	// Anything that reaches for the global fetch is a network call we didn't allow.
	globalThis.fetch = ((url: string) => {
		fetchCalls.push(String(url));
		return Promise.reject(new TypeError("network disabled"));
	}) as unknown as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
	rmSync(dir, { recursive: true, force: true });
});

/** A model folder as the manager leaves it after an install. */
function installFolder(root: string, id: string, version: string, files: Record<string, string>, extras = {}) {
	const d = join(root, id);
	mkdirSync(d, { recursive: true });
	for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
	for (const [name, json] of Object.entries(extras)) writeFileSync(join(d, name), JSON.stringify(json));
	writeFileSync(join(d, "install.json"), JSON.stringify({ id, version, files: Object.keys(files), installedAt: 1 }));
}

function installPack(root: string, src: string, tgt: string) {
	installFolder(
		root,
		`bergamot-${src}-${tgt}`,
		"3.0",
		{ "model.bin": "m", "lex.bin": "l", "vocab.spm": "v" },
		{ "pack.json": { src, tgt, version: "3.0", files: { model: "model.bin", lex: "lex.bin", vocab: "vocab.spm" } } },
	);
}

function catalogueEntry(src: string, tgt: string): BergamotPack {
	const id = `bergamot-${src}-${tgt}`;
	return {
		id,
		source: L(src),
		target: L(tgt),
		sourceCode: src,
		targetCode: tgt,
		version: "3.0",
		architecture: "base-memory",
		files: [
			{ ...plainFile(server, `/${id}/model.bin`, bytes(20_000, 3)), fileType: "model" },
			{ ...plainFile(server, `/${id}/lex.bin`, bytes(2_000, 4)), fileType: "lex" },
			{ ...plainFile(server, `/${id}/vocab.spm`, bytes(1_000, 5)), fileType: "vocab" },
		],
	};
}

async function setup() {
	const root = join(dir, "models");
	installFolder(root, "bergamot-runtime", "bergamot-translator v0.6.0", {
		"bergamot-translator.wasm": "w",
		"bergamot-translator.js": "j",
	});
	installPack(root, "ja", "en");
	installPack(root, "en", "de");
	const manager = new ModelManager({
		root,
		fetch: (url, init) => realFetch(url, init),
		freeBytes: async () => 1e12,
		progressIntervalMs: 0,
	});
	await manager.scan();
	const packs = new ModelManagerPackSource(manager);
	const worker = fakeBergamotWorker();
	const provider = new BergamotTranslationProvider({ packs, spawn: worker.spawn, idleMs: 0 });
	const service = new TranslationPacks({ manager, packs, chain: () => [provider] });
	return { manager, packs, provider, service, worker };
}

describe("offline behaviour and model-missing states", () => {
	test("installed packs translate (direct and pivot) with no network call at all", async () => {
		const { provider, packs } = await setup();
		expect(packs.runtime()?.revision).toBe("bergamot-translator v0.6.0");
		expect(
			packs
				.installed()
				.map((p) => `${p.source}>${p.target}`)
				.sort(),
		).toEqual(["en>de", "ja>en"]);
		expect((await provider.init()).state).toBe("ready");
		const results = await collectTranslations(provider, {
			to: L("de"),
			segments: [{ id: "a", text: "明日です。", from: L("ja") }],
		});
		expect(results.get("a")).toMatchObject({ ok: true, translation: { via: ["en"] } });
		const toEn = await collectTranslations(provider, {
			to: L("en"),
			segments: [{ id: "b", text: "はい。", from: L("ja") }],
		});
		expect(toEn.get("b")?.ok).toBe(true);
		expect(fetchCalls).toEqual([]);
		await provider.dispose();
	});

	test("no runtime → provider model-missing; nothing routes to it", async () => {
		const root = join(dir, "models");
		installPack(root, "ja", "en");
		const manager = new ModelManager({ root });
		await manager.scan();
		const packs = new ModelManagerPackSource(manager);
		const provider = new BergamotTranslationProvider({ packs, spawn: fakeBergamotWorker().spawn });
		expect((await provider.init()).state).toBe("model-missing");
		const service = new TranslationPacks({ manager, packs, chain: () => [provider] });
		expect(service.readiness(L("ja"), L("en"))).toEqual({ state: "unsupported" });
		await provider.dispose();
	});

	test("missing pack: download prompt with size, offline variant, consent download, then it translates", async () => {
		const { manager, packs, provider, service } = await setup();
		await provider.init();
		const ko = catalogueEntry("ko", "en");
		packs.setCatalogue([ko]);

		// Before anything is downloaded the segment fails with model-missing, not a fetch.
		const before = await collectTranslations(provider, {
			to: L("en"),
			segments: [{ id: "k", text: "네.", from: L("ko") }],
		});
		expect(before.get("k")).toMatchObject({ ok: false, error: { code: "model-missing" } });
		expect(manager.state(ko.id).status).toBe("missing");

		const r = service.readiness(L("ko"), L("en"));
		expect(r).toMatchObject({
			state: "needs-download",
			providerId: "bergamot",
			missing: [{ id: ko.id, name: "Korean → English" }],
		});
		const rows = service.rows(
			[
				{ id: "k", from: L("ko") },
				{ id: "j", from: L("ja") },
			],
			L("en"),
		);
		expect(rows).toMatchObject([
			{ lang: "ko", state: "missing", resourceIds: [ko.id], segmentIds: ["k"], bytes: 23_000 },
		]);
		const row = rows[0];
		if (!row) throw new Error("no row");
		expect(packChangedMessage("req-1", row, "en")).toEqual({
			requestId: "req-1",
			lang: "ko",
			langName: "Korean",
			state: "missing",
			bytes: 23_000,
			blockIds: ["k"],
		});

		manager.setOnline(false);
		expect(service.readiness(L("ko"), L("en"))).toMatchObject({ state: "offline" });
		manager.setOnline(true);

		const events: string[] = [];
		service.subscribe((id, s) => events.push(`${id}:${s.status}`));
		const [state] = await service.download([ko.id]);
		expect(state?.status).toBe("installed");
		expect(events).toContain(`${ko.id}:installed`);
		expect(service.readiness(L("ko"), L("en"))).toEqual({ state: "ready", providerId: "bergamot" });
		const after = await collectTranslations(provider, {
			to: L("en"),
			segments: [{ id: "k", text: "네.", from: L("ko") }],
		});
		expect(after.get("k")).toMatchObject({ ok: true, translation: { text: "네. [ko>en]" } });
		// The only network traffic was the consented download, through the manager's own fetch.
		expect(fetchCalls).toEqual([]);
		await provider.dispose();
	});

	test("a failed download shows as failed with its error kind", async () => {
		const { packs, provider, service, manager } = await setup();
		await provider.init();
		const th = catalogueEntry("th", "en");
		server.routes.set(`/${th.id}/model.bin`, { body: bytes(10), status: 500 });
		packs.setCatalogue([th]);
		const [state] = await service.download([th.id]);
		expect(state?.status).toBe("failed");
		const [row] = service.rows([{ id: "t", from: L("th") }], L("en"));
		expect(row?.state).toBe("failed");
		if (row) expect(packChangedMessage("r", row, "en", (id) => manager.state(id)).error).toBe("http");
		await provider.dispose();
	});

	test("download only accepts catalogue packs", async () => {
		const { service, provider } = await setup();
		await expect(service.download(["../../etc"])).rejects.toThrow("not a downloadable pack");
		await provider.dispose();
	});
});
