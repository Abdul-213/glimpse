// Fetch the models in app/models/manifest.json into the dev/CI cache (~/.cache/glimpse/models,
// or $GLIMPSE_MODEL_CACHE), verifying SHA-256. Re-running only fetches what's missing.
//
//   bun scripts/fetch-models.ts            bundled models (what the installer ships)
//   bun scripts/fetch-models.ts --all      every model, including on-demand recognisers, except
//                                          whole translation models (SMaLL-100, 618 MB)
//   bun scripts/fetch-models.ts --all --translation-models   those too (GLIMPSE_SMALL100_DIR tests)
//   bun scripts/fetch-models.ts --stage    also copy the bundled models into dist/models
//   bun scripts/fetch-models.ts --list     print the manifest with sizes; fetch nothing
import { bundledModels, downloadSize, installedSize } from "@glimpse/core";
import {
	defaultCacheDir,
	ensureModel,
	isCached,
	loadManifest,
	manifestPath,
	modelsOut,
	stageBundled,
} from "./model-cache.ts";

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

if (import.meta.main) {
	const args = new Set(process.argv.slice(2));
	const manifest = loadManifest();
	const cacheDir = defaultCacheDir();

	if (args.has("--list")) {
		for (const m of manifest.models) {
			const where = m.bundled ? "bundled  " : "on demand";
			const cached = isCached(m, cacheDir) ? "cached" : "";
			console.log(
				`${where}  ${m.id.padEnd(20)} ${mb(installedSize(m)).padStart(9)}  ${m.licence.padEnd(10)} ${cached}`,
			);
		}
		const bundled = bundledModels(manifest);
		console.log(`\nbundled total: ${mb(bundled.reduce((n, m) => n + installedSize(m), 0))} on disk`);
		const onDemand = manifest.models.filter((m) => !m.bundled);
		console.log(`on demand total: ${mb(onDemand.reduce((n, m) => n + downloadSize(m), 0))} download`);
		process.exit(0);
	}

	console.log(`models: ${manifestPath}\ncache:  ${cacheDir}`);
	const log = (line: string) => console.log(line);
	// CI fetches --all on every manifest change (ci.yml); the 618 MB long-tail model is opt-in.
	const wanted = args.has("--all")
		? manifest.models.filter((m) => m.kind !== "translation-model" || args.has("--translation-models"))
		: bundledModels(manifest);
	for (const m of wanted) await ensureModel(m, { cacheDir, log });
	if (args.has("--stage")) {
		const staged = await stageBundled(manifest, modelsOut, { cacheDir, log });
		console.log(`staged ${staged.join(", ")} -> ${modelsOut}`);
	}
}
