// Folders the model manager uses. Pure path logic, so it can be tested without Electrobun.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Downloaded models live in `<userData>/models` unless the user picked another folder.
 * `userData` is Electrobun's `Utils.paths.userData` (passed in by the composition root).
 *
 * Seam: the storage-location setting belongs to the settings schema (GLIM-53, another agent's
 * work). Until it exists, callers pass `configured = null`.
 */
export function modelsRoot(userData: string, configured: string | null = null): string {
	return configured ? resolve(configured) : join(userData, "models");
}

/**
 * The bundled models folder: `models/` next to the main bundle in a built app (the main bundle
 * sits at `<app>/bun/index.js`, models are copied to `<app>/models`), else `app/dist/models`
 * from a dev checkout. Null when neither has a manifest.
 */
export function bundledModelsDir(mainDir: string): string | null {
	const candidates = [resolve(mainDir, "..", "models"), resolve(mainDir, "..", "..", "dist", "models")];
	return candidates.find((dir) => existsSync(join(dir, "manifest.json"))) ?? null;
}

/** Where the Remote Settings catalogue copy is kept. */
export function catalogueCacheFile(root: string): string {
	return join(root, ".catalogue", "translations-models-v2.json");
}
