import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bundledModels,
	installedSize,
	type ModelFile,
	type ModelManifest,
	OCR_RECOGNIZERS,
	recognizerModel,
} from "@glimpse/core";
import electrobunConfig from "../electrobun.config.ts";
import {
	cachePath,
	defaultCacheDir,
	ensureCached,
	loadManifest,
	sha256Hex,
	stageBundled,
} from "../scripts/model-cache.ts";

describe("checked-in model manifest", () => {
	const manifest = loadManifest();

	test("bundles the detector, the ch and latin recognisers and the Bergamot runtime", () => {
		expect(bundledModels(manifest).map((m) => m.id)).toEqual([
			"ocr-det",
			"ocr-rec-ch",
			"ocr-rec-latin",
			"bergamot-runtime",
		]);
	});

	test("has a recogniser for every family, each with a model and a dictionary", () => {
		for (const r of OCR_RECOGNIZERS) {
			const m = recognizerModel(manifest, r);
			expect(m, r).toBeDefined();
			expect(m?.files.map((f) => f.name.split(".").at(-1))).toEqual(["onnx", "txt"]);
		}
	});

	test("bundle stays small", () => {
		const bytes = bundledModels(manifest).reduce((n, m) => n + installedSize(m), 0);
		expect(bytes).toBeLessThan(40e6); // 34.5 MB at the time of writing; see docs/decisions/GLIM-37
	});

	test("electrobun copies the staged models into the app", () => {
		expect(electrobunConfig.build?.copy?.["dist/models"]).toBe("models");
	});
});

describe("model cache", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "glimpse-models-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const raw = new TextEncoder().encode("model bytes ".repeat(100));
	const zst = new Uint8Array(Bun.zstdCompressSync(raw));
	const plain: ModelFile = {
		name: "a.onnx",
		urls: ["https://a.test/a", "https://b.test/a"],
		sha256: sha256Hex(raw),
		size: raw.byteLength,
	};
	const packed: ModelFile = {
		name: "b.wasm",
		urls: ["https://a.test/b.zst"],
		sha256: sha256Hex(zst),
		size: zst.byteLength,
		compression: "zstd",
		decompressedSha256: sha256Hex(raw),
		decompressedSize: raw.byteLength,
	};

	function fakeFetch(routes: Record<string, Uint8Array | number>) {
		const calls: string[] = [];
		const fetch = async (url: string) => {
			calls.push(url);
			const body = routes[url];
			if (body === undefined) return new Response("nope", { status: 404 });
			if (typeof body === "number") return new Response("err", { status: body });
			return new Response(body.slice().buffer as ArrayBuffer);
		};
		return { fetch, calls };
	}

	test("downloads, verifies and caches by hash; second call hits the cache", async () => {
		const { fetch, calls } = fakeFetch({ "https://a.test/a": raw });
		const path = await ensureCached(plain, { cacheDir: dir, fetch });
		expect(path).toBe(cachePath(dir, plain));
		expect(readFileSync(path)).toEqual(Buffer.from(raw));
		await ensureCached(plain, { cacheDir: dir, fetch });
		expect(calls).toEqual(["https://a.test/a"]);
	});

	test("falls back to the next URL on errors and hash mismatches", async () => {
		const { fetch, calls } = fakeFetch({ "https://a.test/a": new Uint8Array([1, 2, 3]), "https://b.test/a": raw });
		await ensureCached(plain, { cacheDir: dir, fetch });
		expect(calls).toEqual(["https://a.test/a", "https://b.test/a"]);
	});

	test("fails with every URL's error when none verifies", async () => {
		const { fetch } = fakeFetch({ "https://a.test/a": 500 });
		await expect(ensureCached(plain, { cacheDir: dir, fetch })).rejects.toThrow(/could not fetch a.onnx: HTTP 404/);
		expect(existsSync(cachePath(dir, plain))).toBe(false);
	});

	test("unpacks zstd and checks the decompressed hash", async () => {
		const { fetch } = fakeFetch({ "https://a.test/b.zst": zst });
		const path = await ensureCached(packed, { cacheDir: dir, fetch });
		expect(sha256Hex(readFileSync(path))).toBe(sha256Hex(raw));
	});

	test("stages bundled models with manifest and notices", async () => {
		const manifest: ModelManifest = {
			schema: 1,
			models: [
				{
					id: "x",
					kind: "ocr-detector",
					bundled: true,
					licence: "Apache-2.0",
					attribution: "t",
					revision: "1",
					files: [plain],
				},
				{
					id: "y",
					kind: "translation-runtime",
					bundled: false,
					licence: "MPL-2.0",
					attribution: "t",
					revision: "1",
					files: [packed],
				},
			],
		};
		const { fetch } = fakeFetch({ "https://a.test/a": raw });
		const out = join(dir, "out");
		expect(await stageBundled(manifest, out, { cacheDir: join(dir, "cache"), fetch })).toEqual(["x"]);
		expect(readFileSync(join(out, "x", "a.onnx"))).toEqual(Buffer.from(raw));
		expect(existsSync(join(out, "y"))).toBe(false);
		expect(
			JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).models.map((m: { id: string }) => m.id),
		).toEqual(["x"]);
		expect(existsSync(join(out, "NOTICE.txt"))).toBe(true);
		expect(existsSync(join(out, "licenses", "Apache-2.0.txt"))).toBe(true);
		expect(existsSync(join(out, "licenses", "MIT-onnxruntime.txt"))).toBe(true);
	});

	test("cache dir honours GLIMPSE_MODEL_CACHE and XDG_CACHE_HOME", () => {
		expect(defaultCacheDir({ GLIMPSE_MODEL_CACHE: "/tmp/m" })).toBe("/tmp/m");
		expect(defaultCacheDir({ XDG_CACHE_HOME: "/xdg" })).toBe(join("/xdg", "glimpse", "models"));
	});
});
