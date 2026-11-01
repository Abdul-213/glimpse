// The pipeline's grouping and language-detection stages as the app runs them (GLIM-109):
// core's GLIM-56 grouper and the GLIM-21 rules over ELD (GLIM-49). ELD's database loads in the
// background after startup (or on the first detection, whichever comes first); if it can't
// load, detection falls back to the script rules and says so in the log. Shared by the
// composition root and the harness.
import { type BlockGrouper, type Glim21Detector, glim21Detector, type Logger, lineGrouper } from "@glimpse/core";
import { loadEldDetector } from "@glimpse/providers/language-detect";

export interface PipelineStages {
	readonly grouper: BlockGrouper;
	/** `load()` it after startup so the first Snip doesn't pay ELD's load (~0.5 s). */
	readonly detector: Glim21Detector;
}

export function pipelineStages(log?: Pick<Logger, "warn">): PipelineStages {
	return {
		grouper: lineGrouper(),
		detector: glim21Detector({
			detectors: async () => [await loadEldDetector()],
			onLoadError: (error) => log?.warn("language detector unavailable; using script rules only", { error }),
		}),
	};
}
