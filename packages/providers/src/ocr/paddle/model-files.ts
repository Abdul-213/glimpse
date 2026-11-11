// Where the PaddleOCR model files are on disk. The provider never downloads anything
// (ARCHITECTURE.md, provider lifecycle): it asks a `ModelFileSource` for each manifest file and
// reports what is missing as `ModelResource`s the model manager (GLIM-38) understands.
//
// Two layouts exist:
// - Installed: `<dir>/<model id>/<file name>`, used by the app's bundled `models/` folder
//   (GLIM-37) and the model manager's user folder (GLIM-38). `folderModelSource` searches
//   several such folders in order (user folder first, then bundled).
// - The dev/CI cache from `bun run models`: `<cache>/sha256/<installed hash>`.
//   `cacheModelSource` reads that, for tests and `bun` scripts.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	downloadSize,
	type ModelEntry,
	type ModelFile,
	type ModelManifest,
	type ModelResource,
	type OcrRecognizer,
	parseModelManifest,
	recognizerModel,
} from "@glimpse/core";

export interface ModelFileSource {
	readonly manifest: ModelManifest;
	/** Absolute path of an installed, complete file, or null. Synchronous: a stat per file. */
	resolve(model: ModelEntry, file: ModelFile): string | null;
}

const installedSize = (file: ModelFile) => file.decompressedSize ?? file.size;

/** True when `path` exists with the manifest's installed size (a cheap completeness check). */
function complete(path: string, file: ModelFile): boolean {
	try {
		return statSync(path).size === installedSize(file);
	} catch {
		return false;
	}
}

/** Installed layout, searched in order. Missing folders are fine. */
export function folderModelSource(manifest: ModelManifest, dirs: readonly string[]): ModelFileSource {
	return {
		manifest,
		resolve(model, file) {
			for (const dir of dirs) {
				const p = join(dir, model.id, file.name);
				if (complete(p, file)) return p;
			}
			return null;
		},
	};
}

/** `$GLIMPSE_MODEL_CACHE`, else `$XDG_CACHE_HOME/glimpse/models`, else `~/.cache/glimpse/models`. */
export function defaultModelCacheDir(env: Record<string, string | undefined> = process.env): string {
	const explicit = env["GLIMPSE_MODEL_CACHE"];
	if (explicit) return resolve(explicit);
	return join(env["XDG_CACHE_HOME"] || join(homedir(), ".cache"), "glimpse", "models");
}

/** The content-addressed dev cache written by `bun run models`. */
export function cacheModelSource(manifest: ModelManifest, cacheDir = defaultModelCacheDir()): ModelFileSource {
	return {
		manifest,
		resolve(_model, file) {
			const p = join(cacheDir, "sha256", file.decompressedSha256 ?? file.sha256);
			return complete(p, file) ? p : null;
		},
	};
}

/** The checked-in manifest, `app/models/manifest.json`, for tests and scripts in this repo. */
export function repoManifestPath(): string {
	return resolve(import.meta.dir, "../../../../../app/models/manifest.json");
}

export async function loadManifestFile(path: string): Promise<ModelManifest> {
	return parseModelManifest(await Bun.file(path).json());
}

export function repoManifestExists(): boolean {
	return existsSync(repoManifestPath());
}

/** What the model manager shows for a manifest entry. */
export function modelResource(model: ModelEntry): ModelResource {
	const name =
		model.kind === "ocr-detector"
			? "Text detection model"
			: model.recognizer
				? `Text recognition model (${model.recognizer})`
				: model.id;
	return { id: model.id, name, bytes: downloadSize(model) };
}

/** Paths of a recogniser's ONNX model and dictionary. */
export interface RecognizerFiles {
	readonly recognizer: OcrRecognizer;
	readonly model: string;
	readonly dict: string;
	/** Hashes of both files, for the fingerprint. */
	readonly revision: string;
}

export interface DetectorFiles {
	readonly model: string;
	readonly revision: string;
}

/** Locate the detector's file, or the resource to download. */
export function locateDetector(source: ModelFileSource): DetectorFiles | ModelResource {
	const det = source.manifest.models.find((m) => m.kind === "ocr-detector");
	if (!det) return { id: "ocr-det", name: "Text detection model", bytes: null };
	const file = det.files.find((f) => f.name.endsWith(".onnx"));
	const path = file ? source.resolve(det, file) : null;
	if (!file || !path) return modelResource(det);
	return { model: path, revision: file.sha256.slice(0, 16) };
}

export type RecognizerLocation =
	| { readonly status: "installed"; readonly files: RecognizerFiles }
	| { readonly status: "missing"; readonly resource: ModelResource }
	| { readonly status: "unknown" };

/** Locate a recogniser's `.onnx` + `.txt` dictionary. `unknown` when the manifest lacks it. */
export function locateRecognizer(source: ModelFileSource, recognizer: OcrRecognizer): RecognizerLocation {
	const entry = recognizerModel(source.manifest, recognizer);
	if (!entry) return { status: "unknown" };
	const onnx = entry.files.find((f) => f.name.endsWith(".onnx"));
	const dict = entry.files.find((f) => f.name.endsWith(".txt"));
	const model = onnx ? source.resolve(entry, onnx) : null;
	const dictPath = dict ? source.resolve(entry, dict) : null;
	if (!onnx || !dict || !model || !dictPath) return { status: "missing", resource: modelResource(entry) };
	return {
		status: "installed",
		files: {
			recognizer,
			model,
			dict: dictPath,
			revision: `${onnx.sha256.slice(0, 12)}${dict.sha256.slice(0, 4)}`,
		},
	};
}
