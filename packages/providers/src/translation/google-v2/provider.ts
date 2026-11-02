// GLIM-61: Google Cloud Translation Basic (v2) as a translation provider (cloud, opt-in; GLIM-22).
//
// `POST https://translation.googleapis.com/language/translate/v2` with the shared Google Cloud
// key (`x-goog-api-key`): `q[]` (one per segment), `source` always set (from GLIM-21
// detection, so short strings aren't misdetected), `target`, `format: "text"` (so `<` and `&`
// in game text survive) and `model: "nmt"`. v2 takes one source per request, so a batch is
// split by source language, then by the request limits.
//
// - `init()` only checks that a key is saved (no network): `ready` or `needs-key`.
// - `warmup()` refreshes the supported languages from `GET .../v2/languages` (no screen
//   content is sent); until then, and if that fails, the catalogue snapshot is used.
// - Request-level failures (bad key, API off, quota, offline) become per-segment `error`
//   events (the stream only rejects on cancellation), and stop the remaining batches.
// - Every `done` carries cloud provenance; the cache keys on its fingerprint (GLIM-20).
// - Never selected by default, and the registry drops it if listed after a local
//   translator, so it can't become a silent fallback.

import {
	abortable,
	assertUniqueSegmentIds,
	billedCharacters,
	chunkSegments,
	isPlainObject,
	type LanguageCode,
	type PairSupport,
	PROVIDER_IDS,
	ProviderError,
	type ProviderErrorCode,
	type ProviderErrorInfo,
	type ProviderFingerprint,
	type ProviderInfo,
	type ProviderStatus,
	provenanceOf,
	routeFingerprint,
	SecretStoreError,
	StatusCell,
	stableHash,
	type TranslateOptions,
	type TranslationCapabilities,
	type TranslationEvent,
	type TranslationHop,
	type TranslationProvider,
	type TranslationRequest,
	type TranslationSegment,
	throwIfAborted,
	type Unsubscribe,
} from "@glimpse/core";
import {
	callGoogle,
	type FetchLike,
	GOOGLE_SECRET_ID,
	type GoogleCloudContext,
	GoogleError,
	readGoogleKey,
} from "../../google/common.ts";
import { GoogleLanguageTable, parseLanguagesReply } from "./languages.ts";

export const TRANSLATE_V2_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
export const LANGUAGES_V2_ENDPOINT = `${TRANSLATE_V2_ENDPOINT}/languages`;

export const GOOGLE_TRANSLATE_INFO: ProviderInfo & { readonly task: "translation" } = {
	id: PROVIDER_IDS.googleTranslate,
	name: "Google Cloud Translation",
	kind: "cloud",
	task: "translation",
	vendor: "Google",
};

/**
 * v2 limits: Google recommends at most 128 `q` values and keeping a request well under its
 * 100 KB body cap; 30,000 characters stays under it even for 3-byte UTF-8 scripts.
 */
export const GOOGLE_TRANSLATE_LIMITS = {
	maxSegmentsPerRequest: 128,
	maxCharsPerRequest: 30_000,
	maxCharsPerSegment: 5_000,
} as const;

function capabilitiesFor(languages: readonly LanguageCode[]): TranslationCapabilities {
	return {
		kind: "cloud",
		needsNetwork: true,
		secretId: GOOGLE_SECRET_ID,
		languages: { sources: languages, targets: languages },
		pivot: null,
		streaming: false,
		contextSensitive: false,
		...GOOGLE_TRANSLATE_LIMITS,
	};
}

/** Static capabilities for the registry (the catalogue's snapshot of v2 languages). */
export const GOOGLE_TRANSLATE_CAPABILITIES: TranslationCapabilities = capabilitiesFor(
	new GoogleLanguageTable().languages(),
);

export interface GoogleTranslateOptions {
	/** Per-request timeout (snip-popup.md: 10 s for cloud calls). */
	readonly timeoutMs: number;
	/** Refresh the language list from the API in `warmup()`. */
	readonly refreshLanguages: boolean;
}

export const GOOGLE_TRANSLATE_DEFAULTS: GoogleTranslateOptions = { timeoutMs: 10_000, refreshLanguages: true };

/** The model and request shape the cache keys on. Bump when either changes output. */
export const TRANSLATE_V2_MODEL_REVISION = "translate-v2:nmt";
const REQUEST_OPTIONS = { format: "text", model: "nmt" } as const;

/** Request-level failures that would fail every later batch the same way. */
const STOPS_THE_REST: ReadonlySet<ProviderErrorCode> = new Set([
	"needs-key",
	"invalid-key",
	"quota-exceeded",
	"spend-cap",
	"offline",
	"rate-limited",
]);

export class GoogleTranslateProvider implements TranslationProvider {
	readonly info = GOOGLE_TRANSLATE_INFO;
	readonly options: GoogleTranslateOptions;

	readonly #ctx: GoogleCloudContext["google"];
	readonly #fetch: FetchLike;
	readonly #cell = new StatusCell();
	readonly #table = new GoogleLanguageTable();
	readonly #fingerprint: ProviderFingerprint;
	#capabilities: TranslationCapabilities = GOOGLE_TRANSLATE_CAPABILITIES;
	#initPromise: Promise<ProviderStatus> | null = null;
	#refreshing: AbortController | null = null;

	constructor(options: Partial<GoogleTranslateOptions>, ctx: GoogleCloudContext) {
		this.options = { ...GOOGLE_TRANSLATE_DEFAULTS, ...options };
		this.#ctx = ctx.google;
		this.#fetch = ctx.google.fetch ?? ((url, init) => fetch(url, init));
		this.#fingerprint = {
			providerId: this.info.id,
			modelRevision: TRANSLATE_V2_MODEL_REVISION,
			optionsHash: stableHash(REQUEST_OPTIONS),
		};
	}

	/** Languages follow the live list once `refreshLanguages()` has run. */
	get capabilities(): TranslationCapabilities {
		return this.#capabilities;
	}

	/** `snapshot` until a refresh from the API succeeded. */
	get languageSource(): "snapshot" | "live" {
		return this.#table.source;
	}

	get status(): ProviderStatus {
		return this.#cell.status;
	}

	onStatusChange(listener: (status: ProviderStatus) => void): Unsubscribe {
		return this.#cell.subscribe(listener);
	}

	/** Checks that a key is saved; no network. Call again after the key changes. */
	init(signal?: AbortSignal): Promise<ProviderStatus> {
		throwIfAborted(signal, this.info.id);
		const state = this.#cell.status.state;
		if (state === "ready" || state === "disposed") return Promise.resolve(this.#cell.status);
		if (!this.#initPromise) {
			this.#cell.set({ state: "loading" });
			this.#initPromise = this.#checkKey().then((status) => {
				this.#initPromise = null;
				this.#cell.set(status);
				return this.#cell.status;
			});
		}
		return abortable(this.#initPromise, signal, this.info.id);
	}

	async #checkKey(): Promise<ProviderStatus> {
		try {
			return (await this.#ctx.secrets.has(GOOGLE_SECRET_ID)) ? { state: "ready" } : { state: "needs-key" };
		} catch (error) {
			const kind = error instanceof SecretStoreError ? error.kind : "unknown";
			const info = new ProviderError("needs-key", `keychain unavailable: ${kind}`, { providerId: this.info.id });
			return { state: "error", error: info.toInfo() };
		}
	}

	/** Refresh the language list (sends no screen text). Failures keep the current list. */
	async warmup(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal, this.info.id);
		if (!this.options.refreshLanguages || this.#cell.status.state !== "ready") return;
		try {
			await this.refreshLanguages(signal);
		} catch (error) {
			if (error instanceof ProviderError && error.code === "cancelled") throw error;
			// Keep the snapshot; the next translate call reports any key problem.
		}
	}

	/**
	 * `GET /v2/languages` and adopt the list. Resolves with the number of languages; rejects
	 * with a `GoogleError` (bad key, API off, offline) or `cancelled`.
	 */
	async refreshLanguages(signal?: AbortSignal): Promise<number> {
		const id = this.info.id;
		this.#refreshing?.abort();
		const controller = new AbortController();
		this.#refreshing = controller;
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const key = await readGoogleKey(this.#ctx.secrets, "translate", id, signal);
			const json = await callGoogle({
				providerId: id,
				api: "translate",
				fetch: this.#fetch,
				key,
				url: LANGUAGES_V2_ENDPOINT,
				method: "GET",
				signal: controller.signal,
				timeoutMs: this.options.timeoutMs,
			});
			const codes = GoogleLanguageTable.fromCodes(parseLanguagesReply(json));
			if (this.#cell.status.state !== "disposed" && this.#table.replace(codes)) {
				this.#capabilities = capabilitiesFor(this.#table.languages());
			}
			return this.#table.size;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (this.#refreshing === controller) this.#refreshing = null;
		}
	}

	async dispose(): Promise<void> {
		this.#refreshing?.abort();
		this.#cell.set({ state: "disposed" });
		this.#cell.clear();
	}

	#hop(from: LanguageCode, to: LanguageCode): TranslationHop {
		return { from, to, fingerprint: this.#fingerprint };
	}

	pairSupport(from: LanguageCode, to: LanguageCode): PairSupport {
		if (this.#cell.status.state !== "ready") return { status: "unsupported" };
		const source = this.#table.codeFor(from);
		const target = this.#table.codeFor(to);
		if (source === null || target === null || source === target) return { status: "unsupported" };
		return { status: "ready", hops: [this.#hop(from, to)] };
	}

	#error(code: ProviderErrorCode, message: string): ProviderErrorInfo {
		return new ProviderError(code, message, { providerId: this.info.id }).toInfo();
	}

	async *translate(request: TranslationRequest, options: TranslateOptions = {}): AsyncIterable<TranslationEvent> {
		const { signal } = options;
		const id = this.info.id;
		throwIfAborted(signal, id);
		assertUniqueSegmentIds(request, id);
		if (request.segments.length === 0) return;

		const state = this.#cell.status.state;
		if (state !== "ready") {
			const code: ProviderErrorCode = state === "needs-key" ? "needs-key" : "not-ready";
			for (const s of request.segments) {
				throwIfAborted(signal, id);
				yield { type: "error", id: s.id, error: this.#error(code, `provider is ${state}`) };
			}
			return;
		}

		const target = this.#table.codeFor(request.to);
		const bySource = new Map<string, TranslationSegment[]>();
		for (const s of request.segments) {
			throwIfAborted(signal, id);
			const source = this.#table.codeFor(s.from);
			if (s.text.length > GOOGLE_TRANSLATE_LIMITS.maxCharsPerSegment) {
				yield {
					type: "error",
					id: s.id,
					error: this.#error("input-too-large", `segment over ${GOOGLE_TRANSLATE_LIMITS.maxCharsPerSegment} chars`),
				};
				continue;
			}
			if (source === null || target === null || source === target) {
				yield { type: "error", id: s.id, error: this.#error("unsupported-language", `${s.from}→${request.to}`) };
				continue;
			}
			const group = bySource.get(source);
			if (group) group.push(s);
			else bySource.set(source, [s]);
		}
		if (bySource.size === 0 || target === null) return;

		const batches = [...bySource].flatMap(([source, segments]) =>
			chunkSegments(segments, GOOGLE_TRANSLATE_LIMITS).map((batch) => ({ source, batch })),
		);

		let key: string;
		try {
			key = await readGoogleKey(this.#ctx.secrets, "translate", id, signal);
		} catch (error) {
			if (error instanceof ProviderError && error.code === "cancelled") throw error;
			if (error instanceof GoogleError && error.problem === "no-key") this.#cell.set({ state: "needs-key" });
			const info = ProviderError.from(error, id).toInfo();
			for (const { batch } of batches) for (const s of batch) yield { type: "error", id: s.id, error: info };
			return;
		}

		let stop: ProviderErrorInfo | null = null;
		for (const { source, batch } of batches) {
			throwIfAborted(signal, id);
			if (stop) {
				for (const s of batch) yield { type: "error", id: s.id, error: stop };
				continue;
			}
			let texts: string[];
			try {
				texts = await this.#request(key, batch, source, target, signal);
			} catch (error) {
				const e = ProviderError.from(error, id);
				if (e.code === "cancelled") throw e;
				const info = e.toInfo();
				if (STOPS_THE_REST.has(e.code)) stop = info;
				for (const s of batch) yield { type: "error", id: s.id, error: info };
				continue;
			}
			for (const [i, s] of batch.entries()) {
				throwIfAborted(signal, id);
				const text = texts[i] as string;
				yield {
					type: "done",
					id: s.id,
					translation: {
						text,
						from: s.from,
						to: request.to,
						via: [],
						provider: provenanceOf(this.info, routeFingerprint([this.#hop(s.from, request.to)])),
					},
				};
			}
		}
	}

	async #request(
		key: string,
		batch: readonly TranslationSegment[],
		source: string,
		target: string,
		signal: AbortSignal | undefined,
	): Promise<string[]> {
		const id = this.info.id;
		const q = batch.map((s) => s.text);
		// The spend guard (GLIM-120): nothing is sent once it has paused Translation for the month.
		this.#ctx.usage?.admit(id);
		const json = await callGoogle({
			providerId: id,
			api: "translate",
			fetch: this.#fetch,
			key,
			url: TRANSLATE_V2_ENDPOINT,
			body: { q, source, target, ...REQUEST_OPTIONS },
			signal,
			timeoutMs: this.options.timeoutMs,
		});
		this.#ctx.usage?.record(id, billedCharacters(q));
		const texts = parseTranslateReply(json);
		if (texts === null || texts.length !== batch.length) {
			throw new GoogleError(
				"server",
				"translate",
				`Cloud Translation returned ${texts?.length ?? "no"} translations for ${batch.length} segments`,
				{ providerId: id },
			);
		}
		return texts;
	}
}

/** `data.translations[].translatedText`, or null when the reply doesn't have that shape. */
export function parseTranslateReply(json: unknown): string[] | null {
	const data = isPlainObject(json) && isPlainObject(json["data"]) ? json["data"] : null;
	const list = data && Array.isArray(data["translations"]) ? data["translations"] : null;
	if (!list) return null;
	const out: string[] = [];
	for (const t of list) {
		const text = isPlainObject(t) ? t["translatedText"] : undefined;
		if (typeof text !== "string") return null;
		out.push(text);
	}
	return out;
}
