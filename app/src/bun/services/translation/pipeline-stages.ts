// The pipeline's grouping and language-detection stages as the app runs them (GLIM-109):
// core's GLIM-56 grouper and the GLIM-21 rules over ELD (GLIM-49), plus fastText lid.176
// (GLIM-104) once its model is downloaded, for subsets with a language ELD lacks (core's
// `planDetector` chooses per subset). ELD's database loads in the background after startup (or
// on the first detection, whichever comes first); if a detector can't load, detection goes on
// without it and says so in the log. Shared by the composition root and the harness.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	type BlockGrouper,
	type Glim21Detector,
	glim21Detector,
	type LanguageDetector,
	type Logger,
	lineGrouper,
} from "@glimpse/core";
import { FASTTEXT_MODEL_FILE, loadEldDetector, loadFastTextDetector } from "@glimpse/providers/language-detect";

export interface PipelineStages {
	readonly grouper: BlockGrouper;
	/**
	 * `load()` it after startup so the first Snip doesn't pay ELD's load (~0.5 s);
	 * `invalidate()` it when the fastText model is downloaded or removed.
	 */
	readonly detector: Glim21Detector;
}

export interface PipelineStagesOptions {
	/** The installed fastText model's folder (the model manager's `modelDir`), or null. */
	readonly fastTextDir?: () => string | null;
	/** Folder of the main bundle: the build stages `fastText.node.wasm` there (electrobun.config.ts). */
	readonly mainDir?: string;
}

/** The WASM runtime next to the bundled main script, or undefined (dev: fasttext.wasm.js finds its own). */
export function fastTextWasmPath(mainDir: string | undefined): string | undefined {
	const path = mainDir ? join(mainDir, "fastText.node.wasm") : null;
	return path && existsSync(path) ? path : undefined;
}

export function pipelineStages(log?: Pick<Logger, "warn">, options: PipelineStagesOptions = {}): PipelineStages {
	const loadFastText = async (): Promise<LanguageDetector[]> => {
		const dir = options.fastTextDir?.();
		if (!dir) return [];
		try {
			const wasmPath = fastTextWasmPath(options.mainDir);
			return [
				await loadFastTextDetector({ modelPath: join(dir, FASTTEXT_MODEL_FILE), ...(wasmPath ? { wasmPath } : {}) }),
			];
		} catch (error) {
			log?.warn("fastText language identifier unavailable; using ELD and the script rules", { error });
			return [];
		}
	};
	return {
		grouper: lineGrouper(),
		detector: glim21Detector({
			// ELD first: GLIM-21 prefers it whenever it covers the subset.
			detectors: async () => {
				const [eld, fastText] = await Promise.all([loadEldDetector(), loadFastText()]);
				return [eld, ...fastText];
			},
			onLoadError: (error) => log?.warn("language detector unavailable; using script rules only", { error }),
		}),
	};
}
