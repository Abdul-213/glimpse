// Live-mode language detection (GLIM-21 "Live mode"): a text cache so repeat frames are free
// and short blocks reuse earlier decisions (rule 5a), and per-block hysteresis so a block keeps
// its language unless a new detection is confident and different (no flicker as subtitles
// scroll). Block ids come from `BlockIdTracker` (GLIM-56). Reset when the subset, target or
// detector changes: decisions depend on them.

import type { BlockId } from "../../block.ts";
import type { DetectInput, DetectOptions, LanguageDecision } from "./decide.ts";
import { detectCaptureLanguages } from "./decide.ts";
import { detectionCopy, textKey } from "./normalize.ts";

export interface LanguageSessionOptions extends Partial<DetectOptions> {
	readonly subset: DetectOptions["subset"];
	readonly target: DetectOptions["target"];
	readonly detector: DetectOptions["detector"];
	/** Text cache entries. Screen text: cleared with `reset()` by the privacy wipes. */
	readonly maxEntries?: number;
}

const langOf = (d: LanguageDecision) => (d.language.kind === "neutral" ? "neutral" : d.language.lang);

export class LanguageDetectionSession {
	readonly #options: LanguageSessionOptions;
	readonly #max: number;
	readonly #byText = new Map<string, LanguageDecision>();
	#byBlock = new Map<BlockId, LanguageDecision>();

	constructor(options: LanguageSessionOptions) {
		this.#options = options;
		this.#max = options.maxEntries ?? 2048;
	}

	/** Decide one frame's blocks. */
	detect(blocks: readonly DetectInput[]): Map<BlockId, LanguageDecision> {
		const keys = new Map(blocks.map((b) => [b.id, textKey(detectionCopy(b.text))]));
		// Repeat text that was decided confidently is free.
		const fresh = blocks.filter((b) => !this.#byText.get(keys.get(b.id) ?? "")?.confident);
		const decided = detectCaptureLanguages(fresh, this.#options, { get: (k) => this.#byText.get(k) });
		const out = new Map<BlockId, LanguageDecision>();
		const nextByBlock = new Map<BlockId, LanguageDecision>();
		for (const b of blocks) {
			const key = keys.get(b.id) ?? "";
			const cached = this.#byText.get(key);
			let d = decided.get(b.id) ?? (cached ? { ...cached, rule: "5a" as const, confident: cached.confident } : null);
			if (!d) continue;
			const prev = this.#byBlock.get(b.id);
			if (prev && !d.confident && langOf(prev) !== langOf(d)) d = { ...prev, rule: "hysteresis", confident: false };
			out.set(b.id, d);
			nextByBlock.set(b.id, d);
			this.#remember(key, d);
		}
		this.#byBlock = nextByBlock;
		return out;
	}

	#remember(key: string, d: LanguageDecision): void {
		const existing = this.#byText.get(key);
		if (existing?.confident && !d.confident) return;
		this.#byText.delete(key);
		this.#byText.set(key, d);
		while (this.#byText.size > this.#max) {
			const oldest = this.#byText.keys().next();
			if (oldest.done) break;
			this.#byText.delete(oldest.value);
		}
	}

	/** Forget everything (subset/target/detector changed, Live stopped, privacy wipe). */
	reset(): void {
		this.#byText.clear();
		this.#byBlock.clear();
	}
}
