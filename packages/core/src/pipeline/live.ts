// A Live session over the pipeline: the per-session state GLIM-20/21 ask for, and
// "latest wins" between frames (live-popup.md §8).
//
// - Feed it settled frames (`process`); change detection (GLIM-58) decides which frames
//   are worth processing and may pass the changed regions for OCR reuse (GLIM-67).
// - A newer frame cancels the older run. Sentences the older run had in flight are not
//   re-requested: the newer run joins them through the cache's single-flight.
// - Session state: the detection memo (GLIM-21 rule 5a), the session cache (isolated when
//   Private), and the last result, so the Live popup can diff blocks (`diffLiveBlocks`).
// - `setPrivate` switches caches mid-session; `setSources` drops the detection memo
//   (decisions depend on the subset). `close` drops everything.

import type { BlockLanguage } from "../block.ts";
import type { SessionCache, TranslationCaches } from "../cache/caches.ts";
import type { Rect } from "../geometry.ts";
import type { LanguageCode } from "../language/code.ts";
import { isProviderError, ProviderError } from "../providers/errors.ts";
import type { OcrImage } from "../providers/ocr.ts";
import { BlockIdTracker } from "./block-ids.ts";
import type { PipelineListener, PipelineResult } from "./events.ts";
import type { TranslationPipeline } from "./pipeline.ts";

export interface LiveSessionOptions {
	readonly pipeline: TranslationPipeline;
	readonly caches: TranslationCaches;
	readonly target: LanguageCode;
	readonly sources: readonly LanguageCode[];
	readonly private: boolean;
	/** "Use on-device" at the Live cloud consent: cloud translators are skipped (GLIM-79). */
	readonly localOnly?: boolean;
	readonly onEvent?: PipelineListener;
	/** Called once when the session closes (the owner forgets it). */
	readonly onClose?: () => void;
}

interface Run {
	readonly controller: AbortController;
	readonly superseded: () => void;
}

export class LivePipelineSession {
	readonly #opts: LiveSessionOptions;
	#cache: SessionCache;
	#sources: readonly LanguageCode[];
	#target: LanguageCode;
	#memo = new Map<string, BlockLanguage>();
	readonly #ids = new BlockIdTracker();
	#current: Run | null = null;
	#last: PipelineResult | null = null;
	#closed = false;
	#frames = 0;

	constructor(options: LiveSessionOptions) {
		this.#opts = options;
		this.#cache = options.caches.openSession(options.private);
		this.#sources = options.sources;
		this.#target = options.target;
	}

	get private(): boolean {
		return this.#cache.private;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** The latest finished result (what the popup shows). */
	get last(): PipelineResult | null {
		return this.#last;
	}

	get frames(): number {
		return this.#frames;
	}

	/**
	 * Run one settled frame. Resolves with its result, or null when a newer frame (or
	 * `close`) superseded it before it finished.
	 */
	async process(
		image: OcrImage,
		options: { readonly regions?: readonly Rect[]; readonly onEvent?: PipelineListener } = {},
	): Promise<PipelineResult | null> {
		if (this.#closed) return null;
		// The older run is superseded now (its events and result are dropped) but only cancelled
		// once this run has looked its sentences up, so sentences both frames share are joined
		// through single-flight instead of being cancelled and requested again.
		const previous = this.#current;
		previous?.superseded();
		let previousStopped = false;
		const stopPrevious = () => {
			if (previousStopped) return;
			previousStopped = true;
			previous?.controller.abort();
		};
		const controller = new AbortController();
		let superseded = false;
		const run: Run = { controller, superseded: () => (superseded = true) };
		this.#current = run;
		this.#frames++;
		this.#opts.caches.noteActivity();
		const sessionListener = this.#opts.onEvent;
		const runListener = options.onEvent;
		try {
			const result = await this.#opts.pipeline.run(image, {
				mode: "live",
				target: this.#target,
				sources: this.#sources,
				cache: this.#cache.cache,
				private: this.#cache.private,
				signal: controller.signal,
				memo: this.#memo,
				blockIds: this.#ids,
				...(this.#opts.localOnly ? { localOnly: true } : {}),
				...(options.regions ? { regions: options.regions } : {}),
				onEvent: (event) => {
					// Translation lookups run synchronously right after `recognised`.
					if (event.type === "recognised") queueMicrotask(stopPrevious);
					if (superseded) return;
					sessionListener?.(event);
					runListener?.(event);
				},
			});
			if (superseded) return null;
			this.#last = result;
			return result;
		} catch (error) {
			if ((controller.signal.aborted || superseded) && isProviderError(error, "cancelled")) return null;
			throw ProviderError.from(error);
		} finally {
			stopPrevious();
			if (this.#current === run) this.#current = null;
		}
	}

	/** Private toggled from the tray or the popup. Switching drops the old private cache. */
	setPrivate(on: boolean): void {
		if (this.#closed || on === this.#cache.private) return;
		this.#cache.close();
		this.#cache = this.#opts.caches.openSession(on);
	}

	setSources(sources: readonly LanguageCode[]): void {
		this.#sources = sources;
		this.#memo = new Map();
	}

	setTarget(target: LanguageCode): void {
		this.#target = target;
	}

	/** Stop: cancel the frame in flight and drop the session caches. Idempotent. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#current?.superseded();
		this.#current?.controller.abort();
		this.#current = null;
		this.#memo.clear();
		this.#cache.close();
		this.#opts.onClose?.();
	}
}
