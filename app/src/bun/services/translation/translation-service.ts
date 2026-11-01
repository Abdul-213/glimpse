// The main process's translation feature (GLIM-101, GLIM-102): providers built from settings,
// the core pipeline, the GLIM-20 caches and Private mode, behind one object the
// composition root wires to the command bus. No Electrobun imports, so it is tested on Linux.
//
// - `start()` creates the configured providers from the registry, then `init()` + `warmup()`
//   each one in the background (a slow pack load never blocks startup). Statuses are logged.
// - `snip()` / `openLive()` run the pipeline with the cache Private mode asks for.
// - `clearCache()` is the `cache.clear` command; `setPrivate()` the `private.toggle` command.
// - A timer calls `caches.tick()` (idle wipe, sleep wipe).
// - Nothing here touches the network: providers never download (GLIM-57), the cache never
//   pre-fetches, and the catalogue is loaded by whoever owns the model manager.

import {
	type BlockGrouper,
	type BlockLanguageDetector,
	type CacheClearReason,
	type CaptureSource,
	type LanguageCode,
	LivePipelineSession,
	type Logger,
	type OcrProvider,
	type PipelineListener,
	type PipelineResult,
	type ProviderRegistry,
	type ProviderStatus,
	type Rect,
	type Settings,
	sameLanguage,
	TranslationCaches,
	TranslationPipeline,
	type TranslationProvider,
	type TranslationReadiness,
} from "@glimpse/core";

export interface TranslationServiceOptions<Ctx> {
	readonly registry: ProviderRegistry<Ctx>;
	readonly ctx: Ctx;
	readonly settings: () => Settings;
	readonly log: Logger;
	readonly now?: () => number;
	/** Pack download state for pack rows (the app's `TranslationPacks.readiness`). */
	readonly readinessOf?: (from: LanguageCode, to: LanguageCode) => TranslationReadiness;
	readonly grouper?: BlockGrouper;
	readonly detector?: BlockLanguageDetector;
	/** Called when Private changes (the tray mirrors it). */
	readonly onPrivateChange?: (on: boolean) => void;
}

/** The user's sources -> target, as pairs to warm (target itself and duplicates dropped). */
export function warmPairsFor(settings: Settings): { from: LanguageCode; to: LanguageCode }[] {
	const to = settings.language.target;
	return settings.language.sources.filter((s) => !sameLanguage(s, to)).map((from) => ({ from, to }));
}

export class TranslationService<Ctx> {
	readonly caches: TranslationCaches;
	readonly pipeline: TranslationPipeline;
	readonly #opts: TranslationServiceOptions<Ctx>;
	readonly #log: Logger;
	readonly #sessions = new Set<LivePipelineSession>();
	#ocr: OcrProvider | null = null;
	#chain: TranslationProvider[] = [];
	#private: boolean;
	#ticker: ReturnType<typeof setInterval> | null = null;
	#unsubscribe: (() => void)[] = [];

	constructor(options: TranslationServiceOptions<Ctx>) {
		this.#opts = options;
		this.#log = options.log;
		const settings = options.settings();
		this.#private = settings.privacy.privateByDefault;
		this.caches = new TranslationCaches({
			now: options.now ?? Date.now,
			idleMinutes: settings.privacy.clearCacheAfterIdleMinutes,
			onClear: (reason, stats) => this.#log.info("translation cache cleared", { reason, entries: stats.entries }),
		});
		this.pipeline = new TranslationPipeline({
			ocr: () => this.#ocr,
			chain: () => this.#chain,
			...(options.readinessOf ? { readinessOf: options.readinessOf } : {}),
			...(options.grouper ? { grouper: options.grouper } : {}),
			...(options.detector ? { detector: options.detector } : {}),
		});
	}

	get ocr(): OcrProvider | null {
		return this.#ocr;
	}

	/** The translation chain in settings order. */
	get chain(): readonly TranslationProvider[] {
		return this.#chain;
	}

	get private(): boolean {
		return this.#private;
	}

	/**
	 * Build the configured providers and load them. Resolves once every provider has
	 * finished `init()` (and `warmup()` when ready); never rejects.
	 */
	async start(signal?: AbortSignal): Promise<void> {
		const created = this.#opts.registry.create(this.#opts.settings().providers, this.#opts.ctx);
		for (const issue of created.issues) this.#log.warn("provider config", { issue });
		this.#ocr = created.ocr;
		this.#chain = created.translation;
		const all = [...(created.ocr ? [created.ocr] : []), ...created.translation];
		if (!created.ocr) this.#log.info("no OCR provider installed yet; Snip reports ocrFailed");
		await Promise.all(all.map((p) => this.#load(p, signal)));
	}

	async #load(provider: OcrProvider | TranslationProvider, signal?: AbortSignal): Promise<void> {
		const id = provider.info.id;
		this.#unsubscribe.push(
			provider.onStatusChange((status) => this.#log.info("provider status", { provider: id, ...describe(status) })),
		);
		try {
			const t0 = performance.now();
			const status = await provider.init(signal);
			this.#log.info("provider init", { provider: id, ms: Math.round(performance.now() - t0), ...describe(status) });
			if (status.state === "ready" && provider.warmup) {
				const t1 = performance.now();
				await provider.warmup(signal);
				this.#log.info("provider warm", { provider: id, ms: Math.round(performance.now() - t1) });
			}
		} catch (error) {
			this.#log.warn("provider failed to start", { provider: id, error });
		}
	}

	/** One Snip: capture `rect`, run the pipeline, stream events. */
	snip(
		capture: Pick<CaptureSource, "capture">,
		rect: Rect,
		onEvent: PipelineListener,
		signal?: AbortSignal,
	): Promise<PipelineResult> {
		const settings = this.#opts.settings();
		return this.pipeline.snip(capture, rect, {
			target: settings.language.target,
			sources: settings.language.sources,
			cache: this.caches.forSnip(this.#private),
			private: this.#private,
			onEvent,
			...(signal ? { signal } : {}),
		});
	}

	/** A Live session over the pipeline (GLIM-56/58 feed it frames). Close it when done. */
	openLive(onEvent: PipelineListener): LivePipelineSession {
		const settings = this.#opts.settings();
		const session = new LivePipelineSession({
			pipeline: this.pipeline,
			caches: this.caches,
			target: settings.language.target,
			sources: settings.language.sources,
			private: this.#private,
			onEvent,
			onClose: () => this.#sessions.delete(session),
		});
		this.#sessions.add(session);
		return session;
	}

	/** The `private.toggle` command (tray, Live popup). Live sessions switch caches at once. */
	setPrivate(on: boolean): void {
		if (on === this.#private) return;
		this.#private = on;
		for (const session of this.#sessions) session.setPrivate(on);
		this.#log.info("private mode", { on });
		this.#opts.onPrivateChange?.(on);
	}

	/** The `cache.clear` command, and lock / sleep / key-change wipes. */
	clearCache(reason: CacheClearReason = "user"): void {
		this.caches.clear(reason);
	}

	/** Start the wipe timer (idle and sleep detection). */
	startTimers(intervalMs = 30_000): void {
		if (this.#ticker) return;
		this.#ticker = setInterval(() => this.caches.tick(), intervalMs);
		// Don't keep a headless process (tests, harness) alive just for this.
		(this.#ticker as { unref?: () => void }).unref?.();
	}

	async dispose(): Promise<void> {
		if (this.#ticker) clearInterval(this.#ticker);
		this.#ticker = null;
		for (const session of [...this.#sessions]) session.close();
		for (const off of this.#unsubscribe) off();
		this.#unsubscribe = [];
		this.caches.clear("session-end");
		await Promise.all([...(this.#ocr ? [this.#ocr] : []), ...this.#chain].map((p) => p.dispose()));
	}
}

function describe(status: ProviderStatus): Record<string, unknown> {
	switch (status.state) {
		case "model-missing":
			return { state: status.state, missing: status.missing.map((m) => m.id) };
		case "error":
			return { state: status.state, error: status.error.code, message: status.error.message };
		default:
			return { state: status.state };
	}
}
