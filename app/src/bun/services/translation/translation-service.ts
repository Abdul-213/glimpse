// The main process's translation feature (GLIM-101, GLIM-102): providers built from settings,
// the core pipeline, the GLIM-20 caches and Private mode, behind one object the
// composition root wires to the command bus. No Electrobun imports, so it is tested on Linux.
//
// - `start()` creates the configured providers from the registry, then `init()` + `warmup()`
//   each one in the background (a slow pack load never blocks startup). Statuses are logged.
// - `applySettings()` (GLIM-108) takes settings changes without a restart: a new provider
//   selection, order or options rebuilds only the providers whose (id, options) changed (the
//   others, with their loaded models, are kept) and disposes the dropped ones; new
//   languages re-warm the chain and update open Live sessions; the idle-wipe minutes go to the
//   caches. Snip reads target and sources per call, so the next Snip uses them.
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
	stableStringify,
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
	/** Live providers by instance: what built them (`id|options`) and their status listener. */
	readonly #built = new Map<OcrProvider | TranslationProvider, { readonly key: string; readonly off: () => void }>();
	#started = false;
	#private: boolean;
	#ticker: ReturnType<typeof setInterval> | null = null;

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
		this.#started = true;
		await this.#build(this.#opts.settings().providers, signal);
	}

	/**
	 * Build the providers for `config`, reusing every current one built from the same id and
	 * options; swap them in at once (the next run uses them), dispose what is no longer
	 * selected, and load the new ones. Resolves when the new ones are loaded; never rejects.
	 */
	async #build(config: Settings["providers"], signal?: AbortSignal): Promise<void> {
		const { registry, ctx } = this.#opts;
		const selection = registry.resolve(config);
		for (const issue of selection.issues) this.#log.warn("provider config", { issue });
		const reusable = new Map<string, OcrProvider | TranslationProvider>();
		for (const [provider, { key }] of this.#built) reusable.set(key, provider);
		const fresh: (OcrProvider | TranslationProvider)[] = [];
		const take = <P extends OcrProvider | TranslationProvider>(resolved: {
			readonly factory: { readonly info: { readonly id: string }; create(o: unknown, c: Ctx): P };
			readonly options: unknown;
		}): P => {
			const key = `${resolved.factory.info.id}|${stableStringify(resolved.options)}`;
			const existing = reusable.get(key);
			if (existing) {
				reusable.delete(key);
				return existing as P;
			}
			const created = resolved.factory.create(resolved.options, ctx);
			this.#built.set(created, { key, off: this.#watch(created) });
			fresh.push(created);
			return created;
		};
		const ocr = selection.ocr ? take(selection.ocr) : null;
		const chain = selection.translation.map((t) => take(t));
		this.#ocr = ocr;
		this.#chain = chain;
		if (!ocr) this.#log.info("no OCR provider installed yet; Snip reports ocrFailed");
		// What's left wasn't selected again. A run already using one may fail; the next uses the new set.
		const dropped = [...reusable.values()];
		for (const p of dropped) {
			this.#built.get(p)?.off();
			this.#built.delete(p);
		}
		if (dropped.length > 0 || fresh.length > 0) {
			this.#log.info("providers", {
				ocr: ocr?.info.id ?? null,
				chain: chain.map((p) => p.info.id),
				created: fresh.map((p) => p.info.id),
				disposed: dropped.map((p) => p.info.id),
			});
		}
		await Promise.all([
			...dropped.map((p) =>
				p
					.dispose()
					.catch((error: unknown) => this.#log.warn("provider dispose failed", { provider: p.info.id, error })),
			),
			...fresh.map((p) => this.#load(p, signal)),
		]);
	}

	#watch(provider: OcrProvider | TranslationProvider): () => void {
		const id = provider.info.id;
		return provider.onStatusChange((status) =>
			this.#log.info("provider status", { provider: id, ...describe(status) }),
		);
	}

	/**
	 * Settings changed (AppSettings.subscribe). Returns once new providers are loaded and the
	 * chain is re-warmed; the change itself applies synchronously. Never rejects.
	 */
	async applySettings(next: Settings, previous: Settings): Promise<void> {
		if (next.privacy.clearCacheAfterIdleMinutes !== previous.privacy.clearCacheAfterIdleMinutes) {
			this.caches.setIdleMinutes(next.privacy.clearCacheAfterIdleMinutes);
		}
		const { target, sources } = next.language;
		const targetChanged = !sameLanguage(target, previous.language.target);
		const sourcesChanged = stableStringify(sources) !== stableStringify(previous.language.sources);
		for (const session of this.#sessions) {
			if (sourcesChanged) session.setSources(sources);
			if (targetChanged) session.setTarget(target);
		}
		const work: Promise<void>[] = [];
		const providersChanged = stableStringify(next.providers) !== stableStringify(previous.providers);
		if (this.#started && providersChanged) work.push(this.#build(next.providers));
		// New pairs: warm the providers that stay (new ones warm as they load).
		if (this.#started && (targetChanged || sourcesChanged)) {
			const ready = this.#chain.filter((p) => p.status.state === "ready" && p.warmup);
			work.push(...ready.map((p) => this.#warm(p)));
		}
		await Promise.all(work);
	}

	async #warm(provider: OcrProvider | TranslationProvider, signal?: AbortSignal): Promise<void> {
		if (!provider.warmup) return;
		const t1 = performance.now();
		try {
			await provider.warmup(signal);
			this.#log.info("provider warm", { provider: provider.info.id, ms: Math.round(performance.now() - t1) });
		} catch (error) {
			this.#log.warn("provider warmup failed", { provider: provider.info.id, error });
		}
	}

	async #load(provider: OcrProvider | TranslationProvider, signal?: AbortSignal): Promise<void> {
		const id = provider.info.id;
		try {
			const t0 = performance.now();
			const status = await provider.init(signal);
			this.#log.info("provider init", { provider: id, ms: Math.round(performance.now() - t0), ...describe(status) });
			if (status.state === "ready") await this.#warm(provider, signal);
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
		const all = [...this.#built.keys()];
		for (const { off } of this.#built.values()) off();
		this.#built.clear();
		this.#ocr = null;
		this.#chain = [];
		this.caches.clear("session-end");
		await Promise.all(all.map((p) => p.dispose()));
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
