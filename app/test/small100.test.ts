// GLIM-100 in the app: the SMaLL-100 model over the real model manager (fake download server,
// fake Worker), routed behind Bergamot. A long-tail language gets a download row with the
// model's size, nothing downloads without consent, the model translates once it lands, Bergamot
// keeps the pairs it can serve (even when only its pack is missing), and the Worker spawner
// switches onnxruntime telemetry off first.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BergamotPack,
	collectTranslations,
	languageCode,
	type ModelManifest,
	routeTranslation,
} from "@glimpse/core";
import { fakeBergamotWorker, fakeSmall100Worker } from "@glimpse/providers/testing";
import { BergamotTranslationProvider } from "@glimpse/providers/translation/bergamot";
import { Small100TranslationProvider } from "@glimpse/providers/translation/small100";
import { ModelManager } from "../src/bun/services/models/model-manager.ts";
import { ModelManagerPackSource } from "../src/bun/services/translation/bergamot-packs.ts";
import { small100Entry, small100ModelSource } from "../src/bun/services/translation/small100-model.ts";
import {
	resolveSmall100Worker,
	SMALL100_WORKER_FILE,
	small100Spawner,
} from "../src/bun/services/translation/small100-worker.ts";
import { TranslationPacks } from "../src/bun/services/translation/translation-packs.ts";
import { bytes, type FakeServer, plainFile, startFakeServer } from "./fake-model-server.ts";

const L = languageCode;
const realFetch = globalThis.fetch;
let server: FakeServer;
let dir: string;

beforeAll(() => {
	server = startFakeServer();
});
afterAll(() => server.stop());
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "glimpse-small100-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function installFolder(root: string, id: string, version: string, files: Record<string, string>, extras = {}) {
	const d = join(root, id);
	mkdirSync(d, { recursive: true });
	for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
	for (const [name, json] of Object.entries(extras)) writeFileSync(join(d, name), JSON.stringify(json));
	writeFileSync(join(d, "install.json"), JSON.stringify({ id, version, files: Object.keys(files), installedAt: 1 }));
}

/** Built directly: the fake server is plain http, which parseModelManifest rejects. */
function manifest(): ModelManifest {
	return {
		schema: 1,
		models: [
			{
				id: "small100",
				kind: "translation-model" as const,
				bundled: false,
				licence: "MIT",
				attribution: "SMaLL-100 (test)",
				revision: "small100-int8 test",
				files: [
					plainFile(server, "/small100/encoder_model_quantized.onnx", bytes(30_000, 7)),
					plainFile(server, "/small100/decoder_model_merged_quantized.onnx", bytes(20_000, 8)),
					plainFile(server, "/small100/tokenizer.json", bytes(1_000, 9)),
				],
			},
		],
	};
}

function koPack(): BergamotPack {
	const id = "bergamot-ko-en";
	return {
		id,
		source: L("ko"),
		target: L("en"),
		sourceCode: "ko",
		targetCode: "en",
		version: "3.0",
		architecture: "base-memory",
		files: [{ ...plainFile(server, `/${id}/model.bin`, bytes(2_000, 3)), fileType: "model" }],
	};
}

async function setup() {
	const root = join(dir, "models");
	installFolder(root, "bergamot-runtime", "bergamot-translator v0.6.0", {
		"bergamot-translator.wasm": "w",
		"bergamot-translator.js": "j",
	});
	installFolder(
		root,
		"bergamot-ja-en",
		"3.0",
		{ "model.bin": "m", "lex.bin": "l", "vocab.spm": "v" },
		{
			"pack.json": {
				src: "ja",
				tgt: "en",
				version: "3.0",
				files: { model: "model.bin", lex: "lex.bin", vocab: "vocab.spm" },
			},
		},
	);
	const manager = new ModelManager({
		root,
		fetch: (url, init) => realFetch(url, init),
		freeBytes: async () => 1e12,
		progressIntervalMs: 0,
	});
	await manager.scan();
	const m = manifest();
	const packs = new ModelManagerPackSource(manager);
	packs.setCatalogue([koPack()]);
	const source = small100ModelSource(manager, m);
	if (!source) throw new Error("no small100 entry");
	const worker = fakeSmall100Worker();
	const bergamot = new BergamotTranslationProvider({ packs, spawn: fakeBergamotWorker().spawn, idleMs: 0 });
	const small = new Small100TranslationProvider({ model: source, spawn: worker.spawn, idleMs: 0 });
	const chain = [bergamot, small];
	const service = new TranslationPacks({ manager, packs, chain: () => chain, models: m.models });
	return { manager, bergamot, small, chain, service, worker, manifest: m };
}

describe("SMaLL-100 in the app", () => {
	test("the checked-in manifest lists it on demand, never bundled", () => {
		const entry = small100Entry();
		expect(entry).toMatchObject({ id: "small100", kind: "translation-model", bundled: false, licence: "MIT" });
		expect(entry?.files.map((f) => f.name).sort()).toEqual([
			"decoder_model_merged_quantized.onnx",
			"encoder_model_quantized.onnx",
			"tokenizer.json",
		]);
	});

	test("long tail: a download row with the model's size, consent download, then it translates", async () => {
		const { manager, bergamot, small, chain, service, worker } = await setup();
		await Promise.all([bergamot.init(), small.init()]);

		const before = routeTranslation(chain, L("sw"), L("en"));
		expect(before.status === "missing" && before.provider.info.id).toBe("small100");
		const rows = service.rows([{ id: "b1", from: L("sw") }], L("en"));
		expect(rows).toMatchObject([{ lang: "sw", state: "missing", resourceIds: ["small100"], bytes: 51_000 }]);
		expect(worker.log.spawned).toBe(0);
		expect(manager.state("small100").status).toBe("missing");

		const seen: string[] = [];
		service.subscribe((id, s) => seen.push(`${id}:${s.status}`));
		const [state] = await service.download(["small100"]);
		expect(state?.status).toBe("installed");
		expect(seen).toContain("small100:installed");
		expect(service.readiness(L("sw"), L("en"))).toEqual({ state: "ready", providerId: "small100" });
		const out = await collectTranslations(small, {
			to: L("en"),
			segments: [{ id: "b1", text: "Habari.", from: L("sw") }],
		});
		expect(out.get("b1")).toMatchObject({ ok: true, translation: { text: "Habari. [sw>en]" } });
		expect(worker.log.inits).toEqual([manager.modelDir("small100") ?? "not installed"]);
		await Promise.all([bergamot.dispose(), small.dispose()]);
	});

	test("Bergamot keeps its pairs: installed packs, and a missing pack is offered before SMaLL-100", async () => {
		const { bergamot, small, chain, service } = await setup();
		await Promise.all([bergamot.init(), small.init()]);
		await service.download(["small100"]);
		const ja = routeTranslation(chain, L("ja"), L("en"));
		expect(ja.status === "ready" && ja.provider.info.id).toBe("bergamot");
		const ko = routeTranslation(chain, L("ko"), L("en"));
		expect(ko.status === "missing" && ko.provider.info.id).toBe("bergamot");
		expect(service.rows([{ id: "k", from: L("ko") }], L("en"))).toMatchObject([{ resourceIds: ["bergamot-ko-en"] }]);
		await Promise.all([bergamot.dispose(), small.dispose()]);
	});

	test("removing the model drops its Worker and the pair goes back to missing", async () => {
		const { manager, small, service } = await setup();
		await small.init();
		await service.download(["small100"]);
		await collectTranslations(small, { to: L("en"), segments: [{ id: "a", text: "Habari.", from: L("sw") }] });
		expect(small.engine?.running).toBe(true);
		await manager.remove("small100");
		expect(small.engine).toBeNull();
		expect(small.pairSupport(L("sw"), L("en")).status).toBe("missing");
		await small.dispose();
	});

	test("Worker spawner: telemetry off first; env override, then the bundled file, else the default", () => {
		const calls: string[] = [];
		const off = () => {
			calls.push("off");
			return true;
		};
		expect(small100Spawner("/app/bun", {}, () => false, off)).toEqual({ spawn: undefined, path: null });
		expect(calls).toEqual(["off"]);
		const posix = (p: string | null) => p?.replaceAll("\\", "/").replace(/^[A-Z]:/, "") ?? null;
		expect(posix(resolveSmall100Worker("/app/bun", {}, (p) => posix(p) === `/app/bun/${SMALL100_WORKER_FILE}`))).toBe(
			`/app/bun/${SMALL100_WORKER_FILE}`,
		);
		expect(posix(resolveSmall100Worker("/app/bun", { GLIMPSE_SMALL100_WORKER: "/x/w.js" }, () => true))).toBe(
			"/x/w.js",
		);
	});
});
