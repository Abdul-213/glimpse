// PaddleOCR's model files in the app (GLIM-103): the full manifest (bundled + on-demand
// recognisers, app/models/manifest.json, compiled into the main bundle) resolved through the
// model manager, which knows both the bundled folder (<app>/models) and the user's downloads.
import { statSync } from "node:fs";
import { join } from "node:path";
import { type ModelManifest, parseModelManifest } from "@glimpse/core";
import type { ModelFileSource } from "@glimpse/providers/ocr/paddle";
import manifestJson from "../../../../models/manifest.json" with { type: "json" };

export const appModelManifest: ModelManifest = parseModelManifest(manifestJson);

/** Installed size check, like the provider's own folder source: a partial file is missing. */
const complete = (path: string, size: number) => {
	try {
		return statSync(path).size === size;
	} catch {
		return false;
	}
};

export function paddleModelSource(
	manager: { modelDir(id: string): string | null },
	manifest: ModelManifest = appModelManifest,
): ModelFileSource {
	return {
		manifest,
		resolve(model, file) {
			const dir = manager.modelDir(model.id);
			if (!dir) return null;
			const path = join(dir, file.name);
			return complete(path, file.decompressedSize ?? file.size) ? path : null;
		},
	};
}
