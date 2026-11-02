// Electrobun preBuild hook (electrobun.config.ts `scripts.preBuild`). Hutch imports
// this file from a runner, so `import.meta.main` is false here: do the work at top level.
// Hutch sets ELECTROBUN_BUILD_ENV (dev | canary | stable) and ELECTROBUN_OS.
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { NATIVE_LIBS } from "../electrobun.config.ts";
import { buildViews, viewsOut } from "./build-views.ts";
import { buildWorkers, workersOut } from "./build-workers.ts";
import { defaultCacheDir, loadManifest, modelsOut, stageBundled, writeStagingExtras } from "./model-cache.ts";
import { findVcRuntimeDir, ortOut, ortTarget, stageOnnxRuntime, stageVcRuntime } from "./onnxruntime.ts";
import { ensureLegacyOrt, ORT_LEGACY_VERSION, ortPackageFor } from "./onnxruntime-legacy.ts";

const dev = process.env["ELECTROBUN_BUILD_ENV"] === "dev";
const built = await buildViews({ dev });
console.log(`[prebuild] views (${dev ? "dev" : "prod"}): ${built.join(", ")} -> ${viewsOut}`);

// Which onnxruntime-node this target gets (GLIM-89): the npm dependency, or for darwin-x64 the
// pinned 1.23.2, fetched and verified into a cache. Release builds must have it.
const target = ortTarget();
let ortPackageDir: string | undefined;
let ortBin: string | undefined;
if (ortPackageFor(target).kind === "legacy") {
	try {
		ortPackageDir = await ensureLegacyOrt({ log: (line) => console.log(`[prebuild] ${line}`) });
		ortBin = join(ortPackageDir, "bin", "napi-v6");
	} catch (err) {
		if (!dev) throw err;
		console.warn(`[prebuild] WARNING: onnxruntime-node ${ORT_LEGACY_VERSION} unavailable (GLIM-89).\n${String(err)}`);
	}
}

// Inference Workers (GLIM-101): bundled as their own entries, copied next to the main bundle.
const workers = await buildWorkers({ dev, ...(ortPackageDir ? { ortPackageDir } : {}) });
console.log(`[prebuild] workers: ${workers.join(", ")} -> ${workersOut}`);

// onnxruntime-node for the OCR Worker (GLIM-103): this target's binding + runtime only.
const ort = ortPackageFor(target).kind === "legacy" && !ortBin ? null : stageOnnxRuntime(target, ortOut, ortBin);
if (ort) {
	console.log(`[prebuild] onnxruntime ${target.os}-${target.arch}: ${ort.join(", ")} -> ${ortOut}`);
	// Windows: ship the Visual C++ runtime it links, app-local (GLIM-111). Release builds must.
	if (target.os === "win32") {
		const crtDir = findVcRuntimeDir(target.arch);
		if (crtDir) {
			const dlls = stageVcRuntime(ortOut, ort, crtDir);
			console.log(`[prebuild] Visual C++ runtime from ${crtDir}: ${dlls.join(", ")} -> ${ortOut}`);
		} else {
			const msg =
				"no Visual Studio redist folder found (VCToolsRedistDir, GLIMPSE_VCRT_DIR or a Visual Studio install); " +
				"local OCR would need the VC++ redistributable on the user's PC (GLIM-111).";
			if (!dev) throw new Error(`[prebuild] ${msg}`);
			console.warn(`[prebuild] WARNING: ${msg}`);
		}
	}
} else {
	console.warn(
		`[prebuild] WARNING: onnxruntime-node has no ${target.os}-${target.arch} build; local OCR will be unavailable (GLIM-89).`,
	);
}

// Bundled models (GLIM-37): staged from the cache, fetched when missing. Release builds must
// have them. Dev builds without network still build, with an empty models/ folder; the app
// then reports the models as missing and offers to download them (GLIM-38).
const manifest = loadManifest();
try {
	const staged = await stageBundled(manifest, modelsOut, {
		cacheDir: defaultCacheDir(),
		log: (line) => console.log(`[prebuild] ${line.trim()}`),
	});
	console.log(`[prebuild] models: ${staged.join(", ")} -> ${modelsOut}`);
} catch (err) {
	if (!dev || process.env["GLIMPSE_REQUIRE_MODELS"] === "1") throw err;
	console.warn(`[prebuild] WARNING: bundled models unavailable, building without them.\n${String(err)}`);
	rmSync(modelsOut, { recursive: true, force: true });
	writeStagingExtras(modelsOut, { schema: manifest.schema, models: [] });
}

// Native helper: electrobun.config.ts copies it only if it was built first.
const nativeLib = { darwin: NATIVE_LIBS.darwin.from, win32: NATIVE_LIBS.win32.from }[
	process.platform as "darwin" | "win32"
];
if (nativeLib && !existsSync(resolve(import.meta.dir, "..", nativeLib))) {
	const how = process.platform === "darwin" ? "sh native/macos/build.sh" : "pwsh native/windows/build.ps1";
	console.warn(`[prebuild] WARNING: ${nativeLib} is not built; screen capture will be unavailable. Run: ${how}`);
}
