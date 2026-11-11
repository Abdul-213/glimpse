// GLIM-89: Intel Mac builds bundle the pinned onnxruntime-node 1.23.2 (its JS, its
// onnxruntime-common and its darwin/x64 binding), selected at build time by the target.
//
// Always: target selection, integrity checks, the cache preparation over fake tarballs, and the
// OCR Worker's plugin set. With GLIMPSE_ORT_LEGACY_TEST=1 (network, ~100 MB download once):
// the real tarballs are fetched and verified, the OCR Worker is bundled against 1.23.2 and the
// darwin-x64 files are staged, all on Linux.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkers, ORT_BINDING_REQUIRE, workerEntries } from "../scripts/build-workers.ts";
import { ORT_BINDING, stageOnnxRuntime } from "../scripts/onnxruntime.ts";
import {
	ensureLegacyOrt,
	legacyOrtPackageDir,
	legacyOrtRoot,
	matchesIntegrity,
	ORT_LEGACY_TARBALLS,
	ORT_LEGACY_VERSION,
	ortPackageFor,
	type PinnedTarball,
} from "../scripts/onnxruntime-legacy.ts";
import { OCR_WORKER_FILE } from "../src/bun/services/ocr/paddle-worker.ts";
import { SMALL100_WORKER_FILE } from "../src/bun/services/translation/small100-worker.ts";

const tmp = mkdtempSync(join(tmpdir(), "glimpse-ort-legacy-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const sri = (bytes: Uint8Array) => `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;

/** A small npm-style tarball (package/...) with the given files. */
function tarball(name: string, files: Record<string, string>): Uint8Array {
	const src = join(tmp, `src-${name}`);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(src, "package", path, ".."), { recursive: true });
		writeFileSync(join(src, "package", path), text);
	}
	const out = join(tmp, `${name}.tgz`);
	const r = Bun.spawnSync(["tar", "-czf", out, "-C", src, "package"]);
	if (r.exitCode !== 0) throw new Error(r.stderr.toString());
	return new Uint8Array(readFileSync(out));
}

describe("onnxruntime-node per target (GLIM-89)", () => {
	test("darwin-x64 uses the pinned 1.23.2; every other target the npm dependency", () => {
		expect(ortPackageFor({ os: "darwin", arch: "x64" })).toEqual({ kind: "legacy", version: "1.23.2" });
		for (const [os, arch] of [
			["darwin", "arm64"],
			["win32", "x64"],
			["win32", "arm64"],
			["linux", "x64"],
		]) {
			expect(ortPackageFor({ os: os as string, arch: arch as string })).toEqual({ kind: "current" });
		}
	});

	test("the pinned tarballs are both 1.23.2 and carry sha512 integrity", () => {
		for (const t of ORT_LEGACY_TARBALLS) {
			expect(t.url).toContain(`-${ORT_LEGACY_VERSION}.tgz`);
			expect(t.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
		}
		expect(legacyOrtRoot({ GLIMPSE_ORT_LEGACY_DIR: "/x" })).toBe("/x");
		expect(legacyOrtRoot({})).toContain("onnxruntime-node-1.23.2");
	});

	test("integrity: matches only the exact bytes", () => {
		const bytes = new TextEncoder().encode("hello");
		expect(matchesIntegrity(bytes, sri(bytes))).toBe(true);
		expect(matchesIntegrity(new TextEncoder().encode("hellO"), sri(bytes))).toBe(false);
		expect(matchesIntegrity(bytes, "sha1-abc")).toBe(false);
	});

	test("the OCR Worker bundles onnxruntime-node from the legacy folder when given one", () => {
		const names = (dir?: string) => workerEntries(dir)[OCR_WORKER_FILE]?.plugins.map((p) => p.name);
		expect(names()).toEqual(["glimpse-ort-binding"]);
		expect(names("/cache/onnxruntime-node")).toEqual(["glimpse-ort-package", "glimpse-ort-binding"]);
		// GLIM-100: the SMaLL-100 Worker loads the same native runtime, so it bundles the same package.
		const small = workerEntries("/cache/onnxruntime-node")[SMALL100_WORKER_FILE]?.plugins.map((p) => p.name);
		expect(small).toEqual(["glimpse-ort-package", "glimpse-ort-binding"]);
	});
});

describe("ensureLegacyOrt (fake registry)", () => {
	const node = tarball("node", {
		"package.json": '{"name":"onnxruntime-node","version":"1.23.2"}',
		"dist/index.js": "module.exports = 1;",
		"bin/napi-v6/darwin/x64/onnxruntime_binding.node": "bin",
		"bin/napi-v6/linux/x64/onnxruntime_binding.node": "not wanted",
		"script/install.js": "not wanted",
	});
	const common = tarball("common", {
		"package.json": '{"name":"onnxruntime-common","version":"1.23.2"}',
		"dist/cjs/index.js": "",
	});
	const pins = (nodeIntegrity = sri(node)): PinnedTarball[] => [
		{ ...(ORT_LEGACY_TARBALLS[0] as PinnedTarball), url: "https://fake/node.tgz", integrity: nodeIntegrity },
		{ ...(ORT_LEGACY_TARBALLS[1] as PinnedTarball), url: "https://fake/common.tgz", integrity: sri(common) },
	];
	const fetched: string[] = [];
	const fakeFetch = async (url: string) => {
		fetched.push(url);
		return new Response(new Blob([url.endsWith("node.tgz") ? node : common] as BlobPart[]));
	};

	test("fetches, verifies and extracts only the darwin-x64 files; cached afterwards", async () => {
		const root = join(tmp, "cache-ok");
		const dir = await ensureLegacyOrt({ root, fetch: fakeFetch, tarballs: pins() });
		expect(dir).toBe(legacyOrtPackageDir(root));
		expect(readdirSync(join(root, "node_modules")).sort()).toEqual(["onnxruntime-common", "onnxruntime-node"]);
		expect(existsSync(join(dir, "bin/napi-v6/darwin/x64/onnxruntime_binding.node"))).toBe(true);
		expect(existsSync(join(dir, "bin/napi-v6/linux"))).toBe(false);
		expect(existsSync(join(dir, "script"))).toBe(false);
		expect(fetched.length).toBe(2);
		await ensureLegacyOrt({ root, fetch: fakeFetch, tarballs: pins() });
		expect(fetched.length).toBe(2);
	});

	test("a tampered tarball fails the build and leaves no cache behind", async () => {
		const root = join(tmp, "cache-bad");
		await expect(ensureLegacyOrt({ root, fetch: fakeFetch, tarballs: pins(sri(common)) })).rejects.toThrow(
			"integrity mismatch",
		);
		expect(existsSync(root)).toBe(false);
	});
});

describe.if(process.env["GLIMPSE_ORT_LEGACY_TEST"] === "1")("the real onnxruntime-node 1.23.2 (network)", () => {
	test("verified, bundled into the OCR Worker and staged for darwin-x64", async () => {
		const dir = await ensureLegacyOrt();
		expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("1.23.2");
		const common = join(dir, "..", "onnxruntime-common", "package.json");
		expect(JSON.parse(readFileSync(common, "utf8")).version).toBe("1.23.2");
		expect(readFileSync(join(dir, "dist", "binding.js"), "utf8")).toContain(ORT_BINDING_REQUIRE);

		const out = join(tmp, "workers-x64");
		await buildWorkers({ dev: true, outDir: out, ortPackageDir: dir });
		const worker = readFileSync(join(out, OCR_WORKER_FILE), "utf8");
		expect(worker).toContain('"1.23.2"');
		expect(worker).not.toContain('"1.31.1"');
		expect(worker).not.toContain(ORT_BINDING_REQUIRE);
		expect(worker).toContain("GLIMPSE_ORT_BINDING");

		const staged = join(tmp, "stage-darwin-x64");
		const files = stageOnnxRuntime({ os: "darwin", arch: "x64" }, staged, join(dir, "bin", "napi-v6"));
		expect(files).toEqual([ORT_BINDING, "libonnxruntime.1.23.2.dylib"]);
		expect(readdirSync(staged).sort()).toEqual([...(files ?? [])].sort());
	}, 300_000);
});
