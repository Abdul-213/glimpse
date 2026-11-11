// GLIM-47: the local default TranslationProvider on Firefox Translations (Bergamot) packs.
//
// - Packs are one direction each, almost all to or from English, so `ja → de` runs as
//   `ja → en → de` inside one Worker (`translateViaPivoting`). Routes come from core's
//   `planRouteWithDownloads` over installed and downloadable packs, preferring a route that
//   works offline now.
// - Each segment is split into sentences (core `splitSentences`, GLIM-85) and translated
//   sentence by sentence; a segment with several sentences streams `partial`s (cumulative)
//   before `done`.
// - Never downloads anything: a missing pack is `pairSupport` → `missing` with the pack's
//   download size, and `model-missing` errors at translate time (GLIM-57). Once a pack is
//   installed, translating never touches the network.
// - Memory: at most `maxLoadedPacks` packs in the Worker (LRU), the Worker exits after
//   `idleMs` without work, and each newly loaded pack is warmed with a one-word translation.
import {
	abortable,
	allLanguages,
	assertUniqueSegmentIds,
	hashString,
	joinSentences,
	type LanguageCode,
	type LanguagePair,
	languageCode,
	languageName,
	type ModelResource,
	type PairSupport,
	ProviderError,
	type ProviderErrorCode,
	type ProviderErrorInfo,
	type ProviderFingerprint,
	type ProviderInfo,
	type ProviderStatus,
	planRouteWithDownloads,
	provenanceOf,
	routeFingerprint,
	routeVia,
	SEGMENTER_VERSION,
	type SentencePiece,
	StatusCell,
	splitSentences,
	stableHash,
	type TranslateOptions,
	type Translation,
	type TranslationCapabilities,
	type TranslationEvent,
	type TranslationHop,
	type TranslationProvider,
	type TranslationRequest,
	type TranslationSegment,
	throwIfAborted,
	type Unsubscribe,
} from "@glimpse/core";
import { Channel } from "../channel.ts";
import { BergamotEngine, type EngineEvent, type PackRef } from "./engine.ts";
import type { BergamotPackSource, DownloadablePack, InstalledPack } from "./packs.ts";
import type { WorkerSpawner } from "./protocol.ts";
import { MODEL_CONFIG_VERSION } from "./runtime.ts";

export const BERGAMOT_ID = "bergamot";
export const BERGAMOT_RUNTIME_ID = "bergamot-runtime";
const PIVOT = languageCode("en");

export const BERGAMOT_INFO: ProviderInfo & { readonly task: "translation" } = {
	id: BERGAMOT_ID,
	name: "On-device translation",
	kind: "local",
	task: "translation",
	vendor: null,
};

const BERGAMOT_LANGUAGES = allLanguages()
	.filter((l) => l.bergamot !== undefined)
	.map((l) => l.code);

/** Longest segment accepted; the pipeline splits blocks long before this. */
export const MAX_CHARS_PER_SEGMENT = 4000;

export const BERGAMOT_CAPABILITIES: TranslationCapabilities = {
	kind: "local",
	needsNetwork: false,
	secretId: null,
	languages: { sources: BERGAMOT_LANGUAGES, targets: BERGAMOT_LANGUAGES },
	pivot: PIVOT,
	streaming: true,
	contextSensitive: false,
	maxSegmentsPerRequest: null,
	maxCharsPerRequest: null,
	maxCharsPerSegment: MAX_CHARS_PER_SEGMENT,
};

export interface BergamotProviderOptions {
	readonly packs: BergamotPackSource;
	/** Starts the inference Worker. Default: `new Worker(worker.ts)`. */
	readonly spawn?: WorkerSpawner;
	readonly maxLoadedPacks?: number;
	readonly idleMs?: number;
	/** Pairs to load and warm in `warmup()` (the user's usual sources → target). */
	readonly warmPairs?: readonly { readonly from: LanguageCode; readonly to: LanguageCode }[];
	readonly onEvent?: (event: EngineEvent) => void;
}

/** A planned route: hops for `pairSupport`, plus the packs behind them. */
type Plan =
	| { readonly status: "unsupported" }
	| { readonly status: "ready"; readonly hops: readonly TranslationHop[]; readonly packs: readonly PackRef[] }
	| {
			readonly status: "missing";
			readonly hops: readonly TranslationHop[];
			readonly missing: readonly ModelResource[];
	  };

export function defaultSpawn(): WorkerSpawner {
	return () => new Worker(new URL("./worker.ts", import.meta.url).href) as unknown as ReturnType<WorkerSpawner>;
}

const OPTIONS_HASH = stableHash({ config: MODEL_CONFIG_VERSION, segmenter: SEGMENTER_VERSION });

export class BergamotTranslationProvider implements TranslationProvider {
	readonly info = BERGAMOT_INFO;
	readonly capabilities = BERGAMOT_CAPABILITIES;

	readonly #opts: BergamotProviderOptions;
	readonly #cell = new StatusCell();
	readonly #plans = new Map<string, Plan>();
	readonly #unsubscribePacks: Unsubscribe;
	#engine: BergamotEngine | null = null;
	#init: Promise<ProviderStatus> | null = null;

	constructor(options: BergamotProviderOptions) {
		this.#opts = options;
		this.#unsubscribePacks = options.packs.subscribe(() => this.#plans.clear());
	}

	get status(): ProviderStatus {
		return this.#cell.status;
	}

	onStatusChange(listener: (status: ProviderStatus) => void): Unsubscribe {
		return this.#cell.subscribe(listener);
	}

	/** Loaded pack keys (LRU order), for diagnostics and tests. */
	get loadedPacks(): string[] {
		return this.#engine?.loaded ?? [];
	}

	/** The engine, for memory stats and tests. */
	get engine(): BergamotEngine | null {
		return this.#engine;
	}

	init(signal?: AbortSignal): Promise<ProviderStatus> {
		throwIfAborted(signal, this.info.id);
		const state = this.#cell.status.state;
		if (state === "ready" || state === "disposed") return Promise.resolve(this.#cell.status);
		if (!this.#init) {
			this.#cell.set({ state: "loading" });
			this.#init = this.#load().then((status) => {
				this.#init = null;
				this.#cell.set(status);
				return this.#cell.status;
			});
		}
		return abortable(this.#init, signal, this.info.id);
	}

	async #load(): Promise<ProviderStatus> {
		const runtime = this.#opts.packs.runtime();
		if (!runtime) {
			return {
				state: "model-missing",
				missing: [{ id: BERGAMOT_RUNTIME_ID, name: "Translation engine", bytes: null }],
			};
		}
		this.#engine?.dispose();
		const engine = new BergamotEngine({
			spawn: this.#opts.spawn ?? defaultSpawn(),
			runtimeDir: runtime.dir,
			providerId: this.info.id,
			...(this.#opts.maxLoadedPacks === undefined ? {} : { maxLoadedPacks: this.#opts.maxLoadedPacks }),
			...(this.#opts.idleMs === undefined ? {} : { idleMs: this.#opts.idleMs }),
			...(this.#opts.onEvent ? { onEvent: this.#opts.onEvent } : {}),
		});
		try {
			await engine.start();
		} catch (err) {
			engine.dispose();
			return { state: "error", error: ProviderError.from(err, this.info.id).toInfo() };
		}
		if (this.#cell.status.state === "disposed") {
			engine.dispose();
			return this.#cell.status;
		}
		this.#engine = engine;
		this.#plans.clear();
		return { state: "ready" };
	}

	/** Load and warm the packs for `warmPairs` that are installed (call after `init`). */
	async warmup(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal, this.info.id);
		for (const { from, to } of this.#opts.warmPairs ?? []) await this.prepare(from, to, signal);
	}

	/** Load and warm the packs for one pair if they are installed. No-op otherwise. */
	async prepare(from: LanguageCode, to: LanguageCode, signal?: AbortSignal): Promise<void> {
		const engine = this.#engine;
		if (this.#cell.status.state !== "ready" || !engine) return;
		const plan = this.#plan(from, to);
		if (plan.status === "ready") await engine.preload(plan.packs, signal);
	}

	async dispose(): Promise<void> {
		this.#cell.set({ state: "disposed" });
		this.#cell.clear();
		this.#unsubscribePacks();
		this.#engine?.dispose();
		this.#engine = null;
	}

	pairSupport(from: LanguageCode, to: LanguageCode): PairSupport {
		const plan = this.#plan(from, to);
		if (plan.status === "ready") return { status: "ready", hops: plan.hops };
		return plan;
	}

	#plan(from: LanguageCode, to: LanguageCode): Plan {
		if (this.#cell.status.state !== "ready") return { status: "unsupported" };
		const key = `${from}>${to}`;
		let plan = this.#plans.get(key);
		if (!plan) {
			plan = this.#computePlan(from, to);
			this.#plans.set(key, plan);
		}
		return plan;
	}

	#computePlan(from: LanguageCode, to: LanguageCode): Plan {
		const source = this.#opts.packs;
		const runtime = source.runtime();
		if (!runtime) return { status: "unsupported" };
		const installed = source.installed();
		const downloadable = source.downloadable();
		const route = planRouteWithDownloads(from, to, installed, downloadable, { pivots: [PIVOT] });
		if (!route || route.route.kind === "identity") return { status: "unsupported" };
		const pairs: readonly LanguagePair[] = route.route.hops;
		const packOf = (pair: LanguagePair) => pair as InstalledPack | DownloadablePack;
		const runtimeRev = hashString(runtime.revision);
		const hops: TranslationHop[] = pairs.map((pair, i) => {
			const pack = packOf(pair);
			const fingerprint: ProviderFingerprint = {
				providerId: this.info.id,
				modelRevision: `${pack.id}@${pack.version}/${runtimeRev}`,
				optionsHash: OPTIONS_HASH,
			};
			// Requested codes at the ends (pt-BR may use a pt pack), the pivot in between.
			return {
				from: i === 0 ? from : PIVOT,
				to: i === pairs.length - 1 ? to : PIVOT,
				fingerprint,
			};
		});
		if (route.downloads.length > 0) {
			const missing = route.downloads.map((pair): ModelResource => {
				const pack = packOf(pair);
				return {
					id: pack.id,
					name: `${languageName(pack.source)} → ${languageName(pack.target)}`,
					bytes: "bytes" in pack ? pack.bytes : null,
				};
			});
			return { status: "missing", hops, missing };
		}
		const packs = pairs.map((pair) => {
			const pack = packOf(pair) as InstalledPack;
			return { key: `${pack.id}@${pack.version}`, dir: pack.dir };
		});
		return { status: "ready", hops, packs };
	}

	#error(code: ProviderErrorCode, message: string): ProviderErrorInfo {
		return new ProviderError(code, message, { providerId: this.info.id }).toInfo();
	}

	#translation(segment: TranslationSegment, to: LanguageCode, hops: readonly TranslationHop[], text: string) {
		const translation: Translation = {
			text,
			from: segment.from,
			to,
			via: routeVia(hops),
			provider: provenanceOf(this.info, routeFingerprint(hops)),
		};
		return translation;
	}

	async *translate(request: TranslationRequest, options: TranslateOptions = {}): AsyncIterable<TranslationEvent> {
		const { signal } = options;
		const id = this.info.id;
		throwIfAborted(signal, id);
		assertUniqueSegmentIds(request, id);
		const { to } = request;

		// Per-segment checks first; translatable segments are grouped by route.
		const groups = new Map<string, Group>();
		const immediate: TranslationEvent[] = [];
		for (const segment of request.segments) {
			const engine = this.#engine;
			if (this.#cell.status.state !== "ready" || !engine) {
				immediate.push({
					type: "error",
					id: segment.id,
					error: this.#error("not-ready", `provider is ${this.#cell.status.state}`),
				});
				continue;
			}
			if (segment.text.length > MAX_CHARS_PER_SEGMENT) {
				immediate.push({
					type: "error",
					id: segment.id,
					error: this.#error("input-too-large", `segment over ${MAX_CHARS_PER_SEGMENT} chars`),
				});
				continue;
			}
			const plan = this.#plan(segment.from, to);
			if (plan.status === "unsupported") {
				immediate.push({
					type: "error",
					id: segment.id,
					error: this.#error("unsupported-language", `no Bergamot route ${segment.from} → ${to}`),
				});
				continue;
			}
			if (plan.status === "missing") {
				immediate.push({
					type: "error",
					id: segment.id,
					error: this.#error("model-missing", `not installed: ${plan.missing.map((m) => m.id).join(", ")}`),
				});
				continue;
			}
			const pieces = splitSentences(segment.text, segment.from);
			if (pieces.length === 0) {
				immediate.push({ type: "done", id: segment.id, translation: this.#translation(segment, to, plan.hops, "") });
				continue;
			}
			const key = plan.packs.map((p) => p.key).join(">");
			const group = groups.get(key) ?? { plan, items: [] };
			group.items.push({ segment, pieces });
			groups.set(key, group);
		}

		for (const event of immediate) {
			yield event;
			throwIfAborted(signal, id);
		}

		for (const group of groups.values()) {
			yield* this.#runGroup(group, to, signal);
		}
	}

	async *#runGroup(group: Group, to: LanguageCode, signal: AbortSignal | undefined): AsyncGenerator<TranslationEvent> {
		const id = this.info.id;
		const engine = this.#engine;
		const { plan } = group;
		if (!engine) throw new ProviderError("not-ready", "provider disposed", { providerId: id });
		// Flatten every sentence of the group into one Worker call, remembering where each goes.
		const sentences: string[] = [];
		const owner: { item: number; piece: number }[] = [];
		group.items.forEach((item, i) => {
			item.pieces.forEach((piece, j) => {
				sentences.push(piece.text);
				owner.push({ item: i, piece: j });
			});
		});
		const outputs = group.items.map((item) => new Array<string>(item.pieces.length));
		const finished = new Set<number>();
		const channel = new Channel<TranslationEvent>();

		const run = engine.translate(
			plan.packs,
			sentences,
			(index, text) => {
				const where = owner[index];
				const item = where && group.items[where.item];
				const out = where && outputs[where.item];
				if (!where || !item || !out) return;
				out[where.piece] = text;
				const joined = joinSentences(out.slice(0, where.piece + 1), item.pieces, to);
				if (where.piece < item.pieces.length - 1) {
					channel.push({ type: "partial", id: item.segment.id, text: joined });
				} else {
					finished.add(where.item);
					channel.push({
						type: "done",
						id: item.segment.id,
						translation: this.#translation(item.segment, to, plan.hops, joined),
					});
				}
			},
			signal,
		);
		run.then(
			() => channel.close(),
			(err: unknown) => channel.fail(err),
		);

		try {
			for await (const event of channel) {
				throwIfAborted(signal, id);
				yield event;
				throwIfAborted(signal, id);
			}
		} catch (err) {
			const error = ProviderError.from(err, id);
			if (error.code === "cancelled") throw error;
			// Engine failure (worker crash, bad pack): every unfinished segment gets the error.
			for (const [i, item] of group.items.entries()) {
				if (!finished.has(i)) yield { type: "error", id: item.segment.id, error: error.toInfo() };
			}
			return;
		}
		// Defensive: the Worker answered fewer sentences than asked.
		for (const [i, item] of group.items.entries()) {
			if (!finished.has(i)) {
				yield { type: "error", id: item.segment.id, error: this.#error("internal", "no output for segment") };
			}
		}
	}
}

interface Group {
	readonly plan: Plan & { readonly status: "ready" };
	readonly items: { readonly segment: TranslationSegment; readonly pieces: readonly SentencePiece[] }[];
}
