// Electrobun preBuild hook (electrobun.config.ts `scripts.preBuild`). Hutch imports
// this file from a runner, so `import.meta.main` is false here: do the work at top level.
// Hutch sets ELECTROBUN_BUILD_ENV (dev | canary | stable) and ELECTROBUN_OS.
import { rmSync } from "node:fs";
import { buildViews, viewsOut } from "./build-views.ts";
import { defaultCacheDir, loadManifest, modelsOut, stageBundled, writeStagingExtras } from "./model-cache.ts";

const dev = process.env["ELECTROBUN_BUILD_ENV"] === "dev";
const built = await buildViews({ dev });
console.log(`[prebuild] views (${dev ? "dev" : "prod"}): ${built.join(", ")} -> ${viewsOut}`);

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
