// The SMaLL-100 long-tail model in the app (GLIM-100): its manifest entry (`small100` in
// app/models/manifest.json, on demand, never bundled) resolved through the model manager. The
// provider reads `installed()` on every call, so a download that lands mid-session is used at
// once, and a removed or moved model drops its Worker (`subscribe`).
import { downloadSize, type ModelEntry, type ModelManifest } from "@glimpse/core";
import {
	SMALL100_MODEL_ID,
	SMALL100_RESOURCE_NAME,
	type Small100ModelSource,
} from "@glimpse/providers/translation/small100";
import { appModelManifest } from "../ocr/paddle-models.ts";

export { SMALL100_RESOURCE_NAME };

/** Settings › Models row detail: what it is for and what it costs. */
export const SMALL100_DETAIL =
	"Translates about 100 languages that have no language pack. Slower than packs; uses about 1 GB of memory while it works";

export interface Small100Models {
	/** Null when not installed; stays valid while a newer version downloads. */
	modelDir(id: string): string | null;
	installedVersion(id: string): string | null;
	subscribe(listener: (id: string) => void): () => void;
}

export function small100Entry(manifest: ModelManifest = appModelManifest): ModelEntry | null {
	return manifest.models.find((m) => m.id === SMALL100_MODEL_ID && m.kind === "translation-model") ?? null;
}

/** The provider's model source over the model manager. Null when the manifest has no entry. */
export function small100ModelSource(
	models: Small100Models,
	manifest: ModelManifest = appModelManifest,
): Small100ModelSource | null {
	const entry = small100Entry(manifest);
	if (!entry) return null;
	return {
		installed: () => {
			const dir = models.modelDir(entry.id);
			return dir ? { dir, revision: models.installedVersion(entry.id) ?? entry.revision } : null;
		},
		download: { id: entry.id, bytes: downloadSize(entry), revision: entry.revision },
		subscribe: (listener) =>
			models.subscribe((id) => {
				if (id === entry.id) listener();
			}),
	};
}
