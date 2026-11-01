import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallState, ModelFile } from "@glimpse/core";
import { loadBergamotCatalogue, packInstallable } from "../src/bun/services/models/catalogue.ts";
import { DownloadError, downloadFile } from "../src/bun/services/models/download.ts";
import { ModelManager } from "../src/bun/services/models/model-manager.ts";
import { bundledModelsDir, modelsRoot } from "../src/bun/services/models/paths.ts";
import { bytes, type FakeServer, plainFile, sha256Hex, startFakeServer, zstdFile } from "./fake-model-server.ts";

let server: FakeServer;
let dir: string;
beforeAll(() => {
	server = startFakeServer();
});
afterAll(() => server.stop());
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "glimpse-dl-"));
	server.routes.clear();
	server.requests.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const hashOf = (path: string) => sha256Hex(new Uint8Array(readFileSync(path)));
const caught = async (p: Promise<unknown>): Promise<DownloadError> => {
	try {
		await p;
	} catch (err) {
		if (err instanceof DownloadError) return err;
		throw err;
	}
	throw new Error("expected a DownloadError");
};

describe("downloadFile", () => {
	test("downloads with progress and verifies", async () => {
		const body = bytes(10_000);
		const file = plainFile(server, "/a.onnx", body);
		const progress: number[] = [];
		await downloadFile(file, join(dir, "a.onnx"), { onProgress: (r) => progress.push(r) });
		expect(hashOf(join(dir, "a.onnx"))).toBe(file.sha256);
		expect(progress.at(-1)).toBe(10_000);
		expect([...progress].sort((a, b) => a - b)).toEqual(progress);
		expect(existsSync(join(dir, "a.onnx.part"))).toBe(false);
	});

	test("unpacks zstd and checks the decompressed hash", async () => {
		const raw = bytes(50_000, 7);
		const file = zstdFile(server, "/model.bin.zst", raw);
		await downloadFile(file, join(dir, "model.bin"));
		expect(hashOf(join(dir, "model.bin"))).toBe(sha256Hex(raw));
		expect(existsSync(join(dir, "model.bin.part"))).toBe(false);
	});

	test("resumes after a dropped connection with a Range request", async () => {
		const body = bytes(20_000, 3);
		const file = plainFile(server, "/big.bin", body, { dropAfter: { bytes: 8192, times: 1 } });
		const dest = join(dir, "big.bin");
		const first = await caught(downloadFile(file, dest));
		expect(first.kind).toBe("network");
		expect(statSync(`${dest}.part`).size).toBe(8192);
		await downloadFile(file, dest);
		expect(hashOf(dest)).toBe(file.sha256);
		expect(server.requests.map((r) => r.range)).toEqual([null, "bytes=8192-"]);
	});

	test("starts over when the server ignores Range", async () => {
		const body = bytes(5000, 4);
		const file = plainFile(server, "/norange.bin", body, { ranges: false });
		const dest = join(dir, "norange.bin");
		writeFileSync(`${dest}.part`, body.subarray(0, 1000));
		await downloadFile(file, dest);
		expect(hashOf(dest)).toBe(file.sha256);
	});

	test("a corrupt .part is discarded and the next mirror is tried", async () => {
		const body = bytes(4000, 5);
		const good = plainFile(server, "/mirror.bin", body);
		server.routes.set("/corrupt.bin", { body: bytes(4000, 99) });
		const file: ModelFile = { ...good, urls: [server.url("/corrupt.bin"), server.url("/mirror.bin")] };
		const dest = join(dir, "x.bin");
		await downloadFile(file, dest);
		expect(hashOf(dest)).toBe(good.sha256);
	});

	test("checksum failure on every URL", async () => {
		server.routes.set("/bad.bin", { body: bytes(100, 1) });
		const file: ModelFile = { name: "bad.bin", urls: [server.url("/bad.bin")], sha256: "0".repeat(64), size: 100 };
		expect((await caught(downloadFile(file, join(dir, "bad.bin")))).kind).toBe("checksum");
		expect(existsSync(join(dir, "bad.bin.part"))).toBe(false);
	});

	test("HTTP errors and offline", async () => {
		const file = plainFile(server, "/gone.bin", bytes(10), { status: 503 });
		expect((await caught(downloadFile(file, join(dir, "gone.bin")))).kind).toBe("http");
		const offline: ModelFile = { ...file, urls: ["http://127.0.0.1:1/nothing"] };
		expect((await caught(downloadFile(offline, join(dir, "o.bin")))).kind).toBe("network");
	});

	test("cancellation keeps the partial download", async () => {
		const file = plainFile(server, "/slow.bin", bytes(64 * 1024, 6), { slowMs: 5 });
		const dest = join(dir, "slow.bin");
		const controller = new AbortController();
		const p = downloadFile(file, dest, {
			signal: controller.signal,
			onProgress: (r) => {
				if (r >= 4096) controller.abort();
			},
		});
		expect((await caught(p)).kind).toBe("cancelled");
		expect(statSync(`${dest}.part`).size).toBeGreaterThan(0);
		server.routes.set("/slow.bin", { body: bytes(64 * 1024, 6) });
		await downloadFile(file, dest);
		expect(hashOf(dest)).toBe(file.sha256);
		expect(server.requests.at(-1)?.range).toMatch(/^bytes=\d+-$/);
	});

	test("refuses a body longer than the manifest says", async () => {
		const body = bytes(2000, 8);
		server.routes.set("/long.bin", { body });
		const file: ModelFile = { name: "long.bin", urls: [server.url("/long.bin")], sha256: sha256Hex(body), size: 1000 };
		expect((await caught(downloadFile(file, join(dir, "long.bin")))).kind).toBe("checksum");
	});
});

describe("ModelManager", () => {
	const plenty = async () => 1e12;

	function item(id = "bergamot-de-en", version = "3.0", seed = 1) {
		return {
			id,
			version,
			files: [
				zstdFile(server, `/${id}-${version}/model.bin.zst`, bytes(30_000, seed)),
				plainFile(server, `/${id}-${version}/vocab.spm`, bytes(3000, seed + 1)),
			],
			extras: { "pack.json": { src: "de", tgt: "en", version } },
		};
	}

	test("installs atomically and reports each state", async () => {
		const manager = new ModelManager({ root: join(dir, "models"), freeBytes: plenty, progressIntervalMs: 0 });
		await manager.scan();
		const seen: InstallState["status"][] = [];
		manager.subscribe((_id, s) => {
			if (seen.at(-1) !== s.status) seen.push(s.status);
		});
		const final = await manager.install(item());
		expect(final).toEqual({ status: "installed", version: "3.0", bundled: false });
		expect(seen).toEqual(["queued", "downloading", "verifying", "installing", "installed"]);
		const installed = manager.modelDir("bergamot-de-en");
		expect(installed).toBe(join(dir, "models", "bergamot-de-en"));
		expect(readFileSync(join(dir, "models", "bergamot-de-en", "model.bin")).byteLength).toBe(30_000);
		expect(JSON.parse(readFileSync(join(dir, "models", "bergamot-de-en", "pack.json"), "utf8")).src).toBe("de");
		expect(existsSync(join(dir, "models", ".staging", "bergamot-de-en@3.0"))).toBe(false);

		// A fresh manager finds it on scan.
		const again = new ModelManager({ root: join(dir, "models"), freeBytes: plenty });
		await again.scan();
		expect(again.state("bergamot-de-en")).toEqual({ status: "installed", version: "3.0", bundled: false });
		// Installing the same version again does nothing.
		const before = server.requests.length;
		await again.install(item());
		expect(server.requests.length).toBe(before);
	});

	test("checks disk space before downloading", async () => {
		const manager = new ModelManager({ root: join(dir, "models"), freeBytes: async () => 1000 });
		const s = await manager.install(item());
		expect(s.status === "failed" && s.error.kind).toBe("disk-full");
		expect(server.requests.length).toBe(0);
	});

	test("concurrent installs of one model share a download", async () => {
		const manager = new ModelManager({ root: join(dir, "models"), freeBytes: plenty });
		const a = item();
		const [s1, s2] = await Promise.all([manager.install(a), manager.install(a)]);
		expect(s1).toEqual(s2);
		expect(server.requests.length).toBe(2);
	});

	test("cancel returns to missing, and installing again resumes", async () => {
		const manager = new ModelManager({ root: join(dir, "models"), freeBytes: plenty, progressIntervalMs: 0 });
		const it = item();
		const slowPath = `/${it.id}-${it.version}/model.bin.zst`;
		const route = server.routes.get(slowPath);
		if (route) route.slowMs = 5;
		manager.subscribe((id, s) => {
			if (s.status === "downloading" && s.receivedBytes > 2048) manager.cancel(id);
		});
		expect(await manager.install(it)).toEqual({ status: "missing" });
		if (route) route.slowMs = 0;
		const resumed = new ModelManager({ root: join(dir, "models"), freeBytes: plenty });
		expect((await resumed.install(it)).status).toBe("installed");
		expect(server.requests.some((r) => r.path === slowPath && r.range !== null)).toBe(true);
	});

	test("a failed update keeps the old version usable", async () => {
		const manager = new ModelManager({ root: join(dir, "models"), freeBytes: plenty });
		await manager.install(item("bergamot-de-en", "3.0", 1));
		const v2 = item("bergamot-de-en", "3.1", 2);
		server.routes.set(`/bergamot-de-en-3.1/vocab.spm`, { body: bytes(3000, 77) }); // wrong bytes
		const s = await manager.install(v2);
		expect(s.status === "failed" && s.error.kind).toBe("checksum");
		expect(manager.modelDir("bergamot-de-en")).toBe(join(dir, "models", "bergamot-de-en"));
		expect(manager.installedVersion("bergamot-de-en")).toBe("3.0");
		expect(manager.availability([{ id: "bergamot-de-en", downloadBytes: 1 }])).toEqual({ kind: "ready" });

		const fixed = item("bergamot-de-en", "3.1", 2);
		expect((await manager.install(fixed)).status).toBe("installed");
		expect(manager.installedVersion("bergamot-de-en")).toBe("3.1");
		expect(existsSync(join(dir, "models", ".trash"))).toBe(true); // emptied, folder may remain
	});

	test("offline: reports offline, then needs-download once back online", async () => {
		const manager = new ModelManager({ root: join(dir, "models"), freeBytes: plenty });
		const offlineItem = {
			id: "ocr-rec-korean",
			version: "1",
			files: [{ name: "k.onnx", urls: ["http://127.0.0.1:1/k.onnx"], sha256: "0".repeat(64), size: 10 }],
		};
		const s = await manager.install(offlineItem);
		expect(s.status === "failed" && s.error.kind).toBe("network");
		expect(manager.online).toBe(false);
		expect(manager.availability([{ id: "ocr-rec-korean", downloadBytes: 10 }])).toEqual({
			kind: "offline",
			ids: ["ocr-rec-korean"],
		});
		manager.setOnline(true);
		expect(manager.availability([{ id: "ocr-rec-korean", downloadBytes: 10 }]).kind).toBe("failed");
		expect(manager.availability([{ id: "ocr-rec-th", downloadBytes: 8 }])).toEqual({
			kind: "needs-download",
			ids: ["ocr-rec-th"],
			bytes: 8,
		});
	});

	test("bundled models count as installed and can't be removed", async () => {
		const bundled = join(dir, "app", "models");
		mkdirSync(join(bundled, "ocr-det"), { recursive: true });
		writeFileSync(join(bundled, "ocr-det", "det.onnx"), "x");
		const manifest = {
			schema: 1,
			models: [
				{
					id: "ocr-det",
					kind: "ocr-detector",
					bundled: true,
					licence: "Apache-2.0",
					attribution: "t",
					revision: "RapidOCR v3.10.0",
					files: [{ name: "det.onnx", urls: ["https://x.test/d"], sha256: "a".repeat(64), size: 1 }],
				},
			],
		};
		writeFileSync(join(bundled, "manifest.json"), JSON.stringify(manifest));
		const manager = new ModelManager({ root: join(dir, "models"), bundledDir: bundled, freeBytes: plenty });
		await manager.scan();
		expect(manager.state("ocr-det")).toEqual({ status: "installed", version: "RapidOCR v3.10.0", bundled: true });
		await manager.remove("ocr-det");
		expect(manager.modelDir("ocr-det")).toBe(join(bundled, "ocr-det"));
	});

	test("remove and relocate", async () => {
		const manager = new ModelManager({ root: join(dir, "models"), freeBytes: plenty });
		await manager.install(item("bergamot-de-en"));
		await manager.install(item("bergamot-en-de"));
		await manager.remove("bergamot-en-de");
		expect(manager.state("bergamot-en-de")).toEqual({ status: "missing" });
		expect(existsSync(join(dir, "models", "bergamot-en-de"))).toBe(false);

		await manager.relocate(join(dir, "elsewhere"));
		expect(manager.root).toBe(join(dir, "elsewhere"));
		expect(manager.modelDir("bergamot-de-en")).toBe(join(dir, "elsewhere", "bergamot-de-en"));
		expect(existsSync(join(dir, "elsewhere", "bergamot-de-en", "model.bin"))).toBe(true);
		expect(existsSync(join(dir, "models", "bergamot-de-en"))).toBe(false);
	});

	test("rejects unsafe ids", async () => {
		const manager = new ModelManager({ root: join(dir, "models"), freeBytes: plenty });
		await expect(manager.install({ id: "../evil", version: "1", files: [] })).rejects.toThrow(/invalid model id/);
	});
});

describe("Bergamot catalogue", () => {
	const h = (c: string) => c.repeat(64);
	const rs = {
		data: ["model", "lex", "vocab"].map((fileType, i) => ({
			id: `r${i}`,
			name: `${fileType}.deen.bin`,
			version: "3.0",
			fileType,
			architecture: "base-memory",
			sourceLanguage: "de",
			targetLanguage: "en",
			filter_expression: "",
			decompressedHash: h("d"),
			decompressedSize: 100,
			attachment: { hash: h("a"), size: 40, location: `main-workspace/translations-models-v2/${i}.zst` },
		})),
	};

	test("fetches, caches and falls back to the cache when offline", async () => {
		server.routes.set("/records", { body: new TextEncoder().encode(JSON.stringify(rs)) });
		const cacheFile = join(dir, "catalogue.json");
		const live = await loadBergamotCatalogue({ cacheFile, url: server.url("/records") });
		expect(live.source).toBe("network");
		expect(live.packs.map((p) => p.id)).toEqual(["bergamot-de-en"]);
		const first = live.packs[0];
		expect(first && packInstallable(first).extras?.["pack.json"]).toEqual({
			src: "de",
			tgt: "en",
			version: "3.0",
			architecture: "base-memory",
			files: { model: "model.deen.bin", lex: "lex.deen.bin", vocab: "vocab.deen.bin" },
		});

		const offline = await loadBergamotCatalogue({ cacheFile, url: "http://127.0.0.1:1/records" });
		expect(offline.source).toBe("cache");
		expect(offline.packs.length).toBe(1);

		const none = loadBergamotCatalogue({ cacheFile: join(dir, "none.json"), url: "http://127.0.0.1:1/records" });
		await expect(none).rejects.toMatchObject({ kind: "network" });
	});
});

describe("paths", () => {
	test("models root and bundled dir", () => {
		expect(modelsRoot("/data")).toBe(join("/data", "models"));
		expect(modelsRoot("/data", "/custom/models")).toBe("/custom/models");
		const app = join(dir, "app");
		mkdirSync(join(app, "models"), { recursive: true });
		writeFileSync(join(app, "models", "manifest.json"), "{}");
		expect(bundledModelsDir(join(app, "bun"))).toBe(join(app, "models"));
		expect(bundledModelsDir(join(dir, "nowhere", "bun"))).toBeNull();
	});
});
