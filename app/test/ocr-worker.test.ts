// GLIM-103: the PaddleOCR Worker and onnxruntime-node inside the built app.
//
// Always: the resolver, copy rules, which onnxruntime files each target ships (checked against
// the files in the npm package), and the bundled Worker's binding rewrite.
// With the bundled models in the dev cache (`bun run models`): the freshly bundled Worker, in an
// app-shaped folder outside the repo (no node_modules to fall back on), runs one OCR call and
// loads onnxruntime from that folder. The same check runs on a built Linux app
// (app/build/<env>-linux-x64/..., when `bun run build` has been run).
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import config from "../electrobun.config.ts";
import { buildWorkers, ORT_BINDING_REQUIRE } from "../scripts/build-workers.ts";
import { defaultCacheDir, loadManifest, stageBundled } from "../scripts/model-cache.ts";
import { ORT_BINDING, ortBinDir, ortFilesFor, ortTarget, stageOnnxRuntime } from "../scripts/onnxruntime.ts";
import { appModelManifest, paddleModelSource } from "../src/bun/services/ocr/paddle-models.ts";
import { OCR_WORKER_FILE, ocrSpawner, resolveOcrWorker } from "../src/bun/services/ocr/paddle-worker.ts";

const tmp = mkdtempSync(join(tmpdir(), "glimpse-ocr-app-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("resolveOcrWorker", () => {
	test("override, then the bundled file next to the main bundle, else the provider default", () => {
		expect(resolveOcrWorker("/app/bun", { GLIMPSE_OCR_WORKER: "/x/w.js" }, () => false)).toBe("/x/w.js");
		expect(resolveOcrWorker("/app/bun", {}, (p) => p === "/app/bun/ocr-worker.js")).toBe("/app/bun/ocr-worker.js");
		expect(resolveOcrWorker("/app/src/bun", {}, () => false)).toBeNull();
		expect(ocrSpawner("/app/src/bun", {}, () => false).spawn).toBeUndefined();
	});

	test("electrobun.config.ts copies the Worker next to bun/index.js and onnxruntime to native/", () => {
		const copy = config.build.copy as Record<string, string>;
		expect(copy["dist/workers/ocr-worker.js"]).toBe(`bun/${OCR_WORKER_FILE}`);
		expect(copy["dist/onnxruntime"]).toBe("native/onnxruntime");
	});
});

describe("onnxruntime files per target (CPU only)", () => {
	test("each target ships its binding and the one runtime library it links", () => {
		expect(ortFilesFor("linux", "x64")).toEqual([ORT_BINDING, "libonnxruntime.so.1"]);
		expect(ortFilesFor("darwin", "arm64")).toEqual([ORT_BINDING, "libonnxruntime.1.dylib"]);
		expect(ortFilesFor("win32", "x64")).toEqual([ORT_BINDING, "onnxruntime.dll"]);
		expect(ortFilesFor("win32", "arm64")).toEqual([ORT_BINDING, "onnxruntime.dll"]);
		// GLIM-89: no Intel Mac build in onnxruntime-node >= 1.24.
		expect(ortFilesFor("darwin", "x64")).toBeNull();
	});

	test("every listed file exists in the npm package; DirectML and the duplicate dylib are left out", () => {
		for (const [os, arch] of [
			["linux", "x64"],
			["linux", "arm64"],
			["darwin", "arm64"],
			["win32", "x64"],
			["win32", "arm64"],
		] as const) {
			const dir = join(tmp, `stage-${os}-${arch}`);
			const files = stageOnnxRuntime({ os, arch }, dir);
			expect(readdirSync(dir).sort()).toEqual([...(files ?? [])].sort());
			const shipped = readdirSync(join(ortBinDir(), os, arch));
			for (const f of files ?? []) expect(shipped).toContain(f);
		}
		expect(readdirSync(join(tmp, "stage-win32-x64"))).not.toContain("DirectML.dll");
		expect(readdirSync(join(tmp, "stage-darwin-arm64"))).not.toContain("libonnxruntime.1.31.1.dylib");
	});

	test("an unsupported target stages nothing (the build goes on, OCR reports unavailable)", () => {
		const dir = join(tmp, "stage-darwin-x64");
		expect(stageOnnxRuntime({ os: "darwin", arch: "x64" }, dir)).toBeNull();
		expect(readdirSync(dir)).toEqual([]);
		expect(ortTarget({ GLIMPSE_ORT_TARGET: "darwin-x64" })).toEqual({ os: "darwin", arch: "x64" });
		expect(ortTarget({})).toEqual({ os: process.platform, arch: process.arch });
	});
});

describe("app model source", () => {
	test("the compiled-in manifest lists the on-demand recognisers; files resolve through the manager", () => {
		expect(appModelManifest.models.some((m) => m.recognizer && !m.bundled)).toBe(true);
		const source = paddleModelSource({ modelDir: () => null });
		const det = appModelManifest.models.find((m) => m.kind === "ocr-detector");
		const file = det?.files[0];
		if (!det || !file) throw new Error("no detector");
		expect(source.resolve(det, file)).toBeNull();
	});
});

const workersDir = join(tmp, "workers");
let built: Promise<string[]> | null = null;
const buildOnce = () => {
	built ??= buildWorkers({ dev: false, outDir: workersDir });
	return built;
};

test("the bundled OCR Worker loads the binding from ../native/onnxruntime (or GLIMPSE_ORT_BINDING)", async () => {
	expect(await buildOnce()).toContain(OCR_WORKER_FILE);
	const source = readFileSync(join(workersDir, OCR_WORKER_FILE), "utf8");
	expect(source).not.toContain(ORT_BINDING_REQUIRE);
	expect(source).toContain("GLIMPSE_ORT_BINDING");
	expect(source).toMatch(/"native",\s*"onnxruntime",\s*"onnxruntime_binding\.node"/);
}, 60_000);

const cache = defaultCacheDir();
const bundledModels = loadManifest().models.filter((m) => m.bundled && m.kind.startsWith("ocr"));
const haveModels = bundledModels.every((m) =>
	m.files.every((f) => existsSync(join(cache, "sha256", f.decompressedSha256 ?? f.sha256))),
);
const smoke = resolve(import.meta.dir, "..", "scripts", "ocr-smoke.ts");

/** Run one OCR call through the Worker in `appDir` in a fresh process (see ocr-smoke.ts). */
function runSmoke(appDir: string): { text: string[]; ms: number; ortLibs: string[] } {
	const p = Bun.spawnSync([process.execPath, smoke, appDir], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});
	if (p.exitCode !== 0) throw new Error(`ocr-smoke failed: ${p.stderr.toString()}`);
	const out = JSON.parse(p.stdout.toString().trim().split("\n").at(-1) ?? "{}");
	console.log(`ocr-smoke ${appDir}: ${out.ms} ms`);
	return out;
}

/** The app resources folder of a built Linux app, if `bun run build` has produced one. */
function builtApp(): string | null {
	const buildDir = resolve(import.meta.dir, "..", "build");
	if (!existsSync(buildDir)) return null;
	for (const env of readdirSync(buildDir).filter((d) => d.endsWith(`-linux-${process.arch}`))) {
		for (const app of readdirSync(join(buildDir, env))) {
			const dir = join(buildDir, env, app, "Resources", "app");
			if (existsSync(join(dir, "bun", OCR_WORKER_FILE))) return dir;
		}
	}
	return null;
}

const expectInside = (r: { text: string[]; ortLibs: string[] }, appDir: string) => {
	expect(r.text.join("\n")).toContain("Die Datei konnte nicht gespeichert werden.");
	expect(r.text.join("\n")).toContain("会議");
	expect(r.ortLibs.length).toBeGreaterThanOrEqual(2);
	for (const lib of r.ortLibs) expect(lib.startsWith(join(appDir, "native", "onnxruntime"))).toBe(true);
};

describe.skipIf(process.platform !== "linux" || !haveModels)("OCR inside an app-shaped bundle (Linux)", () => {
	test("bundled Worker + staged onnxruntime + bundled models, outside the repo: one OCR call", async () => {
		const appDir = join(tmp, "app");
		mkdirSync(join(appDir, "bun"), { recursive: true });
		await buildOnce();
		cpSync(join(workersDir, OCR_WORKER_FILE), join(appDir, "bun", OCR_WORKER_FILE));
		stageOnnxRuntime(ortTarget(), join(appDir, "native", "onnxruntime"));
		const manifest = loadManifest();
		await stageBundled(
			{ ...manifest, models: manifest.models.filter((m) => m.kind.startsWith("ocr")) },
			join(appDir, "models"),
			{ cacheDir: cache },
		);
		expectInside(runSmoke(appDir), appDir);
	}, 120_000);

	const app = builtApp();
	test.skipIf(!app)(
		"the built Linux app's Worker runs one OCR call on its own onnxruntime",
		() => {
			expectInside(runSmoke(app as string), app as string);
		},
		120_000,
	);
});
