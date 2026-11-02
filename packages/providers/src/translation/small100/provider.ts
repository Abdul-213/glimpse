// GLIM-100: the long-tail local TranslationProvider on SMaLL-100 (alirezamsh/small100, MIT), an
// M2M-100 distillation (12 encoder / 3 decoder layers) that translates directly between M2M-100's
// 100 languages. Second in the default chain (`bergamot`, `small100`), marked `longTail`, so
// routeTranslation only hands it pairs Bergamot can't serve at all (core routing.ts).
//
// - One model, any to any, no pivot: `pairSupport` is one hop, `ready` once the model is
//   installed, `missing` (with the ~0.6 GB download) before. The status is `ready` either way
//   (nothing loads at init), so routing can offer the download for a long-tail language.
// - Never downloads anything (GLIM-57): a missing model is `missing` in `pairSupport` and a
//   `model-missing` error at translate time.
// - The model loads in its own Worker on the first request (engine.ts) and the Worker exits
//   after `idleMs` idle: ~1 GB resident only while the long tail is in use. `warmup()` does
//   nothing unless `warmOnStart` is set, so app start never pays for it.
// - Each segment is split into sentences (core `splitSentences`) and decoded sentence by
//   sentence; a segment with several sentences streams `partial`s (cumulative) before `done`.
import {
	abortable,
	assertUniqueSegmentIds,
	joinSentences,
	type LanguageCode,
	languageName,
	type ModelResource,
	type PairSupport,
	ProviderError,
	type ProviderErrorCode,
	type ProviderErrorInfo,
	type ProviderFingerprint,
	type ProviderInfo,
	type ProviderStatus,
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
import { SMALL100_CONFIG } from "./decode.ts";
import { Small100Engine, type Small100EngineEvent } from "./engine.ts";
import { SMALL100_SOURCES, SMALL100_TARGETS, type Small100ModelSource, small100Code } from "./model.ts";
import type { Small100WorkerSpawner } from "./protocol.ts";

export const SMALL100_ID = "small100";

export const SMALL100_INFO: ProviderInfo & { readonly task: "translation" } = {
	id: SMALL100_ID,
	name: "On-device translation, more languages",
	kind: "local",
	task: "translation",
	vendor: null,
};

/** Longest segment accepted; the pipeline splits blocks long before this. */
export const SMALL100_MAX_CHARS_PER_SEGMENT = 4000;

export const SMALL100_CAPABILITIES: TranslationCapabilities = {
	kind: "local",
	needsNetwork: false,
	secretId: null,
	languages: { sources: SMALL100_SOURCES, targets: SMALL100_TARGETS },
	pivot: null,
	streaming: true,
	contextSensitive: false,
	maxSegmentsPerRequest: null,
	maxCharsPerRequest: null,
	maxCharsPerSegment: SMALL100_MAX_CHARS_PER_SEGMENT,
	longTail: true,
};

/** Display name of the download ("Download … (610 MB)"). */
export const SMALL100_RESOURCE_NAME = "More languages (SMaLL-100)";

export interface Small100ProviderOptions {
	readonly model: Small100ModelSource;
	/** Starts the inference Worker. Default: `new Worker(worker.ts)`. */
	readonly spawn?: Small100WorkerSpawner;
	readonly threads?: number;
	readonly idleMs?: number;
	/** Load the model in `warmup()` (after init). Off by default: it is ~1 GB for the long tail. */
	readonly warmOnStart?: boolean;
	readonly onEvent?: (event: Small100EngineEvent) => void;
}

export function defaultSmall100Spawn(): Small100WorkerSpawner {
	return () => new Worker(new URL("./worker.ts", import.meta.url).href) as unknown as ReturnType<Small100WorkerSpawner>;
}

/** Decoding choices that change the output: part of every hop's fingerprint. */
const OPTIONS_HASH = stableHash({
	decode: "greedy",
	noRepeatNgram: SMALL100_CONFIG.noRepeatNgram,
	maxLength: SMALL100_CONFIG.maxLength,
	segmenter: SEGMENTER_VERSION,
});

type Plan =
	| { readonly status: "unsupported" }
	| {
			readonly status: "ready";
			readonly hops: readonly TranslationHop[];
			readonly from: string;
			readonly to: string;
			readonly dir: string;
	  }
	| {
			readonly status: "missing";
			readonly hops: readonly TranslationHop[];
			readonly missing: readonly ModelResource[];
	  };

export class Small100TranslationProvider implements TranslationProvider {
	readonly info = SMALL100_INFO;
	readonly capabilities = SMALL100_CAPABILITIES;

	readonly #opts: Small100ProviderOptions;
	readonly #cell = new StatusCell();
	readonly #unsubscribeModel: Unsubscribe;
	#engine: Small100Engine | null = null;

	constructor(options: Small100ProviderOptions) {
		this.#opts = options;
		// A removed or moved model: drop the Worker that has the old files open.
		this.#unsubscribeModel =
			options.model.subscribe?.(() => {
				const dir = options.model.installed()?.dir ?? null;
				if (this.#engine && this.#engine.modelDir !== dir) {
					this.#engine.dispose();
					this.#engine = null;
				}
			}) ?? (() => {});
	}

	get status(): ProviderStatus {
		return this.#cell.status;
	}

	onStatusChange(listener: (status: ProviderStatus) => void): Unsubscribe {
		return this.#cell.subscribe(listener);
	}

	/** The engine (when a request has started one), for diagnostics and tests. */
	get engine(): Small100Engine | null {
		return this.#engine;
	}

	init(signal?: AbortSignal): Promise<ProviderStatus> {
		throwIfAborted(signal, this.info.id);
		// Nothing to load up front: the model loads in the Worker on first use.
		if (this.#cell.status.state !== "disposed" && this.#cell.status.state !== "ready") {
			this.#cell.set({ state: "ready" });
		}
		return abortable(Promise.resolve(this.#cell.status), signal, this.info.id);
	}

	async warmup(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal, this.info.id);
		if (!this.#opts.warmOnStart) return;
		const engine = this.#engineFor(this.#opts.model.installed()?.dir ?? null);
		if (engine) await engine.warmup(signal);
	}

	async dispose(): Promise<void> {
		this.#cell.set({ state: "disposed" });
		this.#cell.clear();
		this.#unsubscribeModel();
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
		const src = small100Code(from, "source");
		const tgt = small100Code(to, "target");
		if (!src || !tgt || src === tgt) return { status: "unsupported" };
		const installed = this.#opts.model.installed();
		const download = this.#opts.model.download;
		const fingerprint: ProviderFingerprint = {
			providerId: this.info.id,
			modelRevision: `small100@${installed?.revision ?? download.revision}`,
			optionsHash: OPTIONS_HASH,
		};
		const hops: TranslationHop[] = [{ from, to, fingerprint }];
		if (!installed) {
			return {
				status: "missing",
				hops,
				missing: [{ id: download.id, name: SMALL100_RESOURCE_NAME, bytes: download.bytes }],
			};
		}
		return { status: "ready", hops, from: src, to: tgt, dir: installed.dir };
	}

	#engineFor(dir: string | null): Small100Engine | null {
		if (!dir) return null;
		if (this.#engine && this.#engine.modelDir === dir) return this.#engine;
		this.#engine?.dispose();
		this.#engine = new Small100Engine({
			spawn: this.#opts.spawn ?? defaultSmall100Spawn(),
			modelDir: dir,
			providerId: this.info.id,
			...(this.#opts.threads === undefined ? {} : { threads: this.#opts.threads }),
			...(this.#opts.idleMs === undefined ? {} : { idleMs: this.#opts.idleMs }),
			...(this.#opts.onEvent ? { onEvent: this.#opts.onEvent } : {}),
		});
		return this.#engine;
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

		const groups = new Map<string, Group>();
		const immediate: TranslationEvent[] = [];
		for (const segment of request.segments) {
			if (this.#cell.status.state !== "ready") {
				immediate.push({
					type: "error",
					id: segment.id,
					error: this.#error("not-ready", `provider is ${this.#cell.status.state}`),
				});
				continue;
			}
			if (segment.text.length > SMALL100_MAX_CHARS_PER_SEGMENT) {
				immediate.push({
					type: "error",
					id: segment.id,
					error: this.#error("input-too-large", `segment over ${SMALL100_MAX_CHARS_PER_SEGMENT} chars`),
				});
				continue;
			}
			const plan = this.#plan(segment.from, to);
			if (plan.status === "unsupported") {
				immediate.push({
					type: "error",
					id: segment.id,
					error: this.#error(
						"unsupported-language",
						`SMaLL-100 can't translate ${languageName(segment.from)} → ${languageName(to)}`,
					),
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
			const key = `${plan.from}>${plan.to}`;
			const group = groups.get(key) ?? { plan, items: [] };
			group.items.push({ segment, pieces });
			groups.set(key, group);
		}

		for (const event of immediate) {
			yield event;
			throwIfAborted(signal, id);
		}
		for (const group of groups.values()) yield* this.#runGroup(group, to, signal);
	}

	async *#runGroup(group: Group, to: LanguageCode, signal: AbortSignal | undefined): AsyncGenerator<TranslationEvent> {
		const id = this.info.id;
		const { plan } = group;
		const engine = this.#engineFor(plan.dir);
		if (!engine) throw new ProviderError("not-ready", "model not installed", { providerId: id });
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
			plan.from,
			plan.to,
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
			// Engine failure (Worker crash, damaged model): every unfinished segment gets the error.
			for (const [i, item] of group.items.entries()) {
				if (!finished.has(i)) yield { type: "error", id: item.segment.id, error: error.toInfo() };
			}
			return;
		}
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
