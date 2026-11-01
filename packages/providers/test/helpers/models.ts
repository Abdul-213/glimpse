// Real-model test setup: the PP-OCRv5 files fetched by `bun run models` (bundled set) or
// `bun run models -- --all` (every recogniser) into the dev cache.

import { join } from "node:path";
import type { ModelManifest, OcrRecognizer } from "@glimpse/core";
import {
	cacheModelSource,
	loadManifestFile,
	locateDetector,
	locateRecognizer,
	type ModelFileSource,
	repoManifestPath,
} from "../../src/ocr/paddle/model-files.ts";

export const FIXTURES = join(import.meta.dir, "..", "fixtures", "ocr");

export const manifest: ModelManifest = await loadManifestFile(repoManifestPath());
export const cacheSource: ModelFileSource = cacheModelSource(manifest);

export const hasDetector = "model" in locateDetector(cacheSource);
export const hasRecognizer = (r: OcrRecognizer): boolean =>
	hasDetector && locateRecognizer(cacheSource, r).status === "installed";

/** Bundled models present: det + ch + latin. */
export const hasBundled = hasRecognizer("ch") && hasRecognizer("latin");

let warned = false;
export function warnIfMissing(): void {
	if (hasBundled || warned) return;
	warned = true;
	console.warn(
		"[skip] PaddleOCR real-model tests: models not in the dev cache. Run `bun run models` (or `bun run models -- --all`).",
	);
}
