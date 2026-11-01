// A deterministic in-memory TranslationProvider for tests in every package.
//
//   const t = new FakeTranslationProvider({ pairs: [["ja", "en"], ["en", "de"]], pivot: "en" });
//   await t.init();
//   await collectTranslations(t, { to: languageCode("de"), segments: [...] });
//   // "こんにちは" -> "こんにちは [ja>en] [en>de]"
//
// Knobs: which pairs exist, which hops are "not downloaded", per-segment failures, a
// `gate` to hold a segment (for cancellation and ordering tests), streaming on/off.

import type { Translation } from "../block.ts";
import { type LanguageCode, languageCode } from "../language.ts";
import {
	abortable,
	ProviderError,
	type ProviderErrorCode,
	type ProviderErrorInfo,
	throwIfAborted,
} from "../providers/errors.ts";
import { type ModelResource, type ProviderStatus, StatusCell, type Unsubscribe } from "../providers/lifecycle.ts";
import { type ProviderFingerprint, type ProviderInfo, provenanceOf, stableHash } from "../providers/provenance.ts";
import {
	assertUniqueSegmentIds,
	type PairSupport,
	routeFingerprint,
	routeVia,
	type TranslateOptions,
	type TranslationCapabilities,
	type TranslationEvent,
	type TranslationHop,
	type TranslationProvider,
	type TranslationRequest,
	type TranslationSegment,
} from "../providers/translation.ts";

type Pair = readonly [string, string];

export interface FakeTranslationOptions {
	readonly id?: string;
	readonly name?: string;
	readonly kind?: "local" | "cloud";
	readonly vendor?: string | null;
	/** Direct pairs, as BCP-47 strings, or `any` (every from != to). Default `any`. */
	readonly pairs?: readonly Pair[] | "any";
	/** Pivot language for pairs without a direct entry. Default none. */
	readonly pivot?: string | null;
	/** Hops that exist but are "not downloaded": `pairSupport` reports `missing`. */
	readonly missing?: readonly Pair[];
	readonly capabilities?: Partial<TranslationCapabilities>;
	/** One hop's output. Default appends `[from>to]`, so pivots are visible in tests. */
	readonly translate?: (text: string, from: LanguageCode, to: LanguageCode) => string;
	/** Return an error code to fail that segment with an `error` event. */
	readonly fail?: (segment: TranslationSegment, to: LanguageCode) => ProviderErrorCode | null;
	/** Awaited before each segment is produced. Hold it open to test cancellation. */
	readonly gate?: (segment: TranslationSegment, signal: AbortSignal | undefined) => Promise<void>;
	/** What `init()` ends in. Default ready. */
	readonly initStatus?: ProviderStatus | (() => ProviderStatus | Promise<ProviderStatus>);
	/** Base model revision; each hop's revision is `<base>:<from>-<to>`. Default `fake-1`. */
	readonly modelRevision?: string;
	/** Options that go into the fingerprint's `optionsHash`. */
	readonly options?: Readonly<Record<string, unknown>>;
}

const pairKey = (from: string, to: string) => `${from}>${to}`;

export class FakeTranslationProvider implements TranslationProvider {
	readonly info: ProviderInfo & { readonly task: "translation" };
	readonly capabilities: TranslationCapabilities;
	/** Every request received, in order. */
	readonly calls: TranslationRequest[] = [];
	initCalls = 0;
	warmupCalls = 0;

	readonly #cell = new StatusCell();
	readonly #opts: FakeTranslationOptions;
	readonly #pairs: ReadonlySet<string> | "any";
	readonly #missing: ReadonlySet<string>;
	readonly #pivot: LanguageCode | null;
	readonly #optionsHash: string;
	#initPromise: Promise<ProviderStatus> | null = null;

	constructor(options: FakeTranslationOptions = {}) {
		this.#opts = options;
		const kind = options.kind ?? "local";
		this.info = {
			id: options.id ?? "fake-translation",
			name: options.name ?? "Fake translation",
			kind,
			task: "translation",
			vendor: options.vendor ?? (kind === "cloud" ? "Fake Cloud Inc." : null),
		};
		const pairs = options.pairs ?? "any";
		this.#pairs = pairs === "any" ? "any" : new Set(pairs.map(([a, b]) => pairKey(languageCode(a), languageCode(b))));
		this.#missing = new Set((options.missing ?? []).map(([a, b]) => pairKey(languageCode(a), languageCode(b))));
		this.#pivot = options.pivot ? languageCode(options.pivot) : null;
		this.#optionsHash = stableHash(options.options ?? {});
		const languages =
			pairs === "any"
				? { sources: "any" as const, targets: "any" as const }
				: {
						sources: [...new Set(pairs.map(([a]) => languageCode(a)))],
						targets: [...new Set(pairs.map(([, b]) => languageCode(b)))],
					};
		this.capabilities = {
			kind,
			needsNetwork: kind === "cloud",
			secretId: kind === "cloud" ? "fake-cloud" : null,
			languages,
			pivot: this.#pivot,
			streaming: true,
			contextSensitive: false,
			maxSegmentsPerRequest: null,
			maxCharsPerRequest: null,
			maxCharsPerSegment: null,
			...options.capabilities,
		};
	}

	get status(): ProviderStatus {
		return this.#cell.status;
	}

	onStatusChange(listener: (status: ProviderStatus) => void): Unsubscribe {
		return this.#cell.subscribe(listener);
	}

	/** Force a status, e.g. to simulate a pack being deleted while running. */
	setStatus(status: ProviderStatus): void {
		this.#cell.set(status);
	}

	init(signal?: AbortSignal): Promise<ProviderStatus> {
		throwIfAborted(signal, this.info.id);
		const state = this.#cell.status.state;
		if (state === "ready" || state === "disposed") return Promise.resolve(this.#cell.status);
		if (!this.#initPromise) {
			this.initCalls++;
			this.#cell.set({ state: "loading" });
			const initStatus = this.#opts.initStatus ?? { state: "ready" };
			this.#initPromise = Promise.resolve(typeof initStatus === "function" ? initStatus() : initStatus).then(
				(status) => {
					this.#initPromise = null;
					this.#cell.set(status);
					return this.#cell.status;
				},
			);
		}
		return abortable(this.#initPromise, signal, this.info.id);
	}

	async warmup(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal, this.info.id);
		this.warmupCalls++;
	}

	async dispose(): Promise<void> {
		this.#cell.set({ state: "disposed" });
		this.#cell.clear();
	}

	#hop(from: LanguageCode, to: LanguageCode): TranslationHop {
		const fingerprint: ProviderFingerprint = {
			providerId: this.info.id,
			modelRevision: `${this.#opts.modelRevision ?? "fake-1"}:${from}-${to}`,
			optionsHash: this.#optionsHash,
		};
		return { from, to, fingerprint };
	}

	#hasDirect(from: LanguageCode, to: LanguageCode): boolean {
		if (from === to) return false;
		return this.#pairs === "any" || this.#pairs.has(pairKey(from, to));
	}

	pairSupport(from: LanguageCode, to: LanguageCode): PairSupport {
		if (this.#cell.status.state !== "ready") return { status: "unsupported" };
		let hops: TranslationHop[];
		if (this.#hasDirect(from, to)) hops = [this.#hop(from, to)];
		else if (
			this.#pivot &&
			from !== this.#pivot &&
			to !== this.#pivot &&
			this.#hasDirect(from, this.#pivot) &&
			this.#hasDirect(this.#pivot, to)
		) {
			hops = [this.#hop(from, this.#pivot), this.#hop(this.#pivot, to)];
		} else return { status: "unsupported" };
		const missing: ModelResource[] = hops
			.filter((h) => this.#missing.has(pairKey(h.from, h.to)))
			.map((h) => ({ id: `${this.info.id}:${h.from}-${h.to}`, name: `${h.from} → ${h.to}`, bytes: null }));
		return missing.length > 0 ? { status: "missing", hops, missing } : { status: "ready", hops };
	}

	#error(code: ProviderErrorCode, message: string): ProviderErrorInfo {
		return new ProviderError(code, message, { providerId: this.info.id }).toInfo();
	}

	async *translate(request: TranslationRequest, options: TranslateOptions = {}): AsyncIterable<TranslationEvent> {
		const { signal } = options;
		const id = this.info.id;
		throwIfAborted(signal, id);
		assertUniqueSegmentIds(request, id);
		this.calls.push(request);
		const hopText = this.#opts.translate ?? ((text, from, to) => `${text} [${from}>${to}]`);

		for (const segment of request.segments) {
			throwIfAborted(signal, id);
			if (this.#cell.status.state !== "ready") {
				yield { type: "error", id: segment.id, error: this.#error("not-ready", `provider is ${this.status.state}`) };
				continue;
			}
			const max = this.capabilities.maxCharsPerSegment;
			if (max !== null && segment.text.length > max) {
				yield { type: "error", id: segment.id, error: this.#error("input-too-large", `segment over ${max} chars`) };
				continue;
			}
			const support = this.pairSupport(segment.from, request.to);
			if (support.status !== "ready") {
				const code = support.status === "missing" ? "model-missing" : "unsupported-language";
				yield { type: "error", id: segment.id, error: this.#error(code, `${segment.from}→${request.to}`) };
				continue;
			}
			const failure = this.#opts.fail?.(segment, request.to) ?? null;
			if (failure) {
				yield { type: "error", id: segment.id, error: this.#error(failure, "scripted failure") };
				continue;
			}
			if (this.#opts.gate) await abortable(this.#opts.gate(segment, signal), signal, id);
			throwIfAborted(signal, id);

			const text = support.hops.reduce((acc, hop) => hopText(acc, hop.from, hop.to), segment.text);
			if (this.capabilities.streaming) {
				const words = text.split(/(?<=\s)/);
				let sofar = "";
				for (const word of words.slice(0, -1)) {
					sofar += word;
					yield { type: "partial", id: segment.id, text: sofar };
					throwIfAborted(signal, id);
				}
			}
			const translation: Translation = {
				text,
				from: segment.from,
				to: request.to,
				via: routeVia(support.hops),
				provider: provenanceOf(this.info, routeFingerprint(support.hops)),
			};
			yield { type: "done", id: segment.id, translation };
		}
	}
}

/** A gate you open by hand: `const g = manualGate(); new Fake({ gate: g.wait }); g.open()`. */
export function manualGate(): {
	readonly wait: (segment: unknown, signal?: AbortSignal) => Promise<void>;
	readonly open: () => void;
	readonly waiting: () => number;
} {
	let release: () => void = () => {};
	let opened = false;
	let waiters = 0;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		wait: () => {
			if (opened) return Promise.resolve();
			waiters++;
			return promise.finally(() => {
				waiters--;
			});
		},
		open: () => {
			opened = true;
			release();
		},
		waiting: () => waiters,
	};
}
