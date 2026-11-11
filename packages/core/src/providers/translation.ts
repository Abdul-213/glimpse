// GLIM-33: the translation provider contract.
//
// A request is a batch of segments (sentences or blocks, each with its own detected
// source language, GLIM-21) and one target language. The provider streams events back:
// optional `partial`s while a segment is being produced, then exactly one terminal
// `done` or `error` per segment. Snip renders partials as they arrive; Live sends only
// the changed blocks of a frame as one batch (GLIM-85 "batch the changed blocks").
//
// Implementations: Bergamot (local default, English pivot), SMaLL-100 (long tail),
// Hy-MT2 (optional Enhanced), Google Translation v2 (cloud opt-in), NLLB (opt-in).
// Contract tests: `translationProviderContract` in `@glimpse/core/testing`.

import type { Translation } from "../block.ts";
import type { LanguageCode } from "../language.ts";
import { ProviderError, type ProviderErrorInfo } from "./errors.ts";
import type { ModelResource, ProviderLifecycle } from "./lifecycle.ts";
import type { ProviderFingerprint, ProviderInfo, ProviderKind } from "./provenance.ts";

export interface TranslationSegment {
	/** Caller's id, unique within the request (block id, or `blockId#sentence`). */
	readonly id: string;
	/** Normalised text: exactly what the cache hashed (GLIM-20). */
	readonly text: string;
	readonly from: LanguageCode;
}

export interface TranslationRequest {
	readonly segments: readonly TranslationSegment[];
	readonly to: LanguageCode;
	/**
	 * Neighbouring lines, for `contextSensitive` providers only (Hy-MT2, DeepL `context`,
	 * LLMs), and only when the user turned context on (GLIM-22). Others ignore it.
	 */
	readonly context?: readonly string[];
}

export interface TranslateOptions {
	readonly signal?: AbortSignal;
}

export type TranslationEvent =
	/** The segment's output so far (cumulative, not a delta). Only from `streaming` providers. */
	| { readonly type: "partial"; readonly id: string; readonly text: string }
	| { readonly type: "done"; readonly id: string; readonly translation: Translation }
	| { readonly type: "error"; readonly id: string; readonly error: ProviderErrorInfo };

/** How (and whether) a provider can serve one language pair right now. */
export type PairSupport =
	/** Ready. `hops` is the route: one hop for a direct model, two for an English pivot. */
	| { readonly status: "ready"; readonly hops: readonly TranslationHop[] }
	/** Servable once these resources are downloaded ("Download Thai → English (31 MB)"). */
	| { readonly status: "missing"; readonly hops: readonly TranslationHop[]; readonly missing: readonly ModelResource[] }
	/** Never servable by this provider: route to another one (GLIM-43 `routeTranslation`). */
	| { readonly status: "unsupported" };

/**
 * One model step. The cache keys each hop separately (GLIM-20: `ja→en` and `en→de` are
 * separate entries), so a hop carries its own fingerprint (each Bergamot pack has its own
 * model revision). A provider must accept any of its hops as a direct one-hop request.
 */
export interface TranslationHop {
	readonly from: LanguageCode;
	readonly to: LanguageCode;
	readonly fingerprint: ProviderFingerprint;
}

export interface LanguageSupport {
	/** Every source it can ever serve (installed or downloadable), or `any`. For UI lists. */
	readonly sources: readonly LanguageCode[] | "any";
	readonly targets: readonly LanguageCode[] | "any";
}

export interface TranslationCapabilities {
	readonly kind: ProviderKind;
	readonly needsNetwork: boolean;
	/** Keychain entry id (see `OcrCapabilities.secretId`), or null. */
	readonly secretId: string | null;
	readonly languages: LanguageSupport;
	/** Pivot language for pairs without a direct model (`en` for Bergamot), or null. */
	readonly pivot: LanguageCode | null;
	/** Emits `partial` events before `done`. */
	readonly streaming: boolean;
	/** Output depends on `TranslationRequest.context` (GLIM-20 adds a context hash). */
	readonly contextSensitive: boolean;
	/** Limits; null means none. Callers split batches with `chunkSegments`. */
	readonly maxSegmentsPerRequest: number | null;
	readonly maxCharsPerRequest: number | null;
	/** Longer segments get an `input-too-large` error; callers should split sentences first. */
	readonly maxCharsPerSegment: number | null;
	/**
	 * Long-tail provider (SMaLL-100, GLIM-100): `routeTranslation` gives it only pairs that no
	 * earlier provider in the chain can serve, not even after a download. Absent = false.
	 */
	readonly longTail?: boolean;
}

export interface TranslationProvider extends ProviderLifecycle {
	readonly info: ProviderInfo & { readonly task: "translation" };
	readonly capabilities: TranslationCapabilities;
	/**
	 * Can this provider translate `from → to`, and by which route? Synchronous: answers from
	 * state loaded by `init()` (which packs are installed). `unsupported` before init.
	 */
	pairSupport(from: LanguageCode, to: LanguageCode): PairSupport;
	/**
	 * Translate a batch. The contract (checked by `translationProviderContract`):
	 * 1. Every segment gets exactly one terminal event (`done` or `error`), in any order.
	 *    No events for unknown ids, nothing for a segment after its terminal event.
	 * 2. `partial`s only from streaming providers, only before that segment's terminal.
	 * 3. Per-segment problems (unsupported pair, pack missing, too long, request-level
	 *    failures such as a bad key or no network) are `error` events, not throws.
	 * 4. When the signal fires, iteration rejects with `ProviderError("cancelled")` promptly
	 *    and yields nothing more. That is the only rejection, apart from `invalid-request`
	 *    for duplicate segment ids.
	 * 5. `done.translation`: `from` = the segment's `from`, `to` = request `to`, `via` = the
	 *    pivot languages used (`routeVia`), `provider.id` = `info.id`, and the fingerprint
	 *    fields equal `routeFingerprint(hops)` for the route `pairSupport` reported.
	 */
	translate(request: TranslationRequest, options?: TranslateOptions): AsyncIterable<TranslationEvent>;
}

/**
 * The fingerprint of a whole route, for `Translation.provider`: hop revisions (and
 * distinct option hashes) joined with `+`. One hop gives that hop's fingerprint.
 */
export function routeFingerprint(hops: readonly TranslationHop[]): ProviderFingerprint {
	const first = hops[0];
	if (!first) throw new RangeError("a route needs at least one hop");
	const optionHashes = [...new Set(hops.map((h) => h.fingerprint.optionsHash))];
	return {
		providerId: first.fingerprint.providerId,
		modelRevision: hops.map((h) => h.fingerprint.modelRevision).join("+"),
		optionsHash: optionHashes.join("+"),
	};
}

/** The pivot languages of a route: `ja→en→de` gives `[en]`. */
export const routeVia = (hops: readonly TranslationHop[]): LanguageCode[] => hops.slice(1).map((h) => h.from);

/** The result of draining a translate stream: per-segment outcome. */
export type SegmentOutcome =
	| { readonly ok: true; readonly translation: Translation }
	| { readonly ok: false; readonly error: ProviderErrorInfo };

/**
 * Drain a translate stream into a map of id → outcome. Segments the provider never
 * answered (a contract bug) get an `internal` error, so callers always see every id.
 * Rejects only with `cancelled` (or `invalid-request`).
 */
export async function collectTranslations(
	provider: TranslationProvider,
	request: TranslationRequest,
	options: TranslateOptions & { readonly onPartial?: (id: string, text: string) => void } = {},
): Promise<Map<string, SegmentOutcome>> {
	const out = new Map<string, SegmentOutcome>();
	const { onPartial, ...rest } = options;
	for await (const event of provider.translate(request, rest)) {
		if (out.has(event.id)) continue;
		if (event.type === "partial") onPartial?.(event.id, event.text);
		else if (event.type === "done") out.set(event.id, { ok: true, translation: event.translation });
		else out.set(event.id, { ok: false, error: event.error });
	}
	for (const segment of request.segments) {
		if (!out.has(segment.id)) {
			out.set(segment.id, {
				ok: false,
				error: new ProviderError("internal", "provider returned no result for segment", {
					providerId: provider.info.id,
				}).toInfo(),
			});
		}
	}
	return out;
}

/**
 * Split segments into batches that respect a provider's request limits, keeping order.
 * A segment longer than `maxCharsPerRequest` gets a batch of its own (the provider will
 * report `input-too-large` for it if it also exceeds `maxCharsPerSegment`).
 */
export function chunkSegments<S extends { readonly text: string }>(
	segments: readonly S[],
	capabilities: Pick<TranslationCapabilities, "maxSegmentsPerRequest" | "maxCharsPerRequest">,
): S[][] {
	const maxCount = capabilities.maxSegmentsPerRequest ?? Number.POSITIVE_INFINITY;
	const maxChars = capabilities.maxCharsPerRequest ?? Number.POSITIVE_INFINITY;
	const batches: S[][] = [];
	let current: S[] = [];
	let chars = 0;
	for (const segment of segments) {
		const len = segment.text.length;
		if (current.length > 0 && (current.length >= maxCount || chars + len > maxChars)) {
			batches.push(current);
			current = [];
			chars = 0;
		}
		current.push(segment);
		chars += len;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

/** `invalid-request` if segment ids repeat. Providers call this before doing any work. */
export function assertUniqueSegmentIds(request: TranslationRequest, providerId: string): void {
	const seen = new Set<string>();
	for (const { id } of request.segments) {
		if (seen.has(id)) {
			throw new ProviderError("invalid-request", `duplicate segment id ${JSON.stringify(id)}`, { providerId });
		}
		seen.add(id);
	}
}

/** True when `code` is in a language list (exact match, or `any`). */
export const supportsLanguage = (list: readonly LanguageCode[] | "any", code: LanguageCode): boolean =>
	list === "any" || list.includes(code);
