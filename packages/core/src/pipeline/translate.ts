// The translation stage: translate-class blocks -> sentences -> cache / provider, per hop.
//
// 1. Plan: each block's source language is routed through the provider chain
//    (`routeTranslation`, GLIM-43). Ready routes translate; pairs that need a download
//    become pack rows (GLIM-57) and their blocks wait; unsupported pairs fail at once.
// 2. Split: a block is normalised (GLIM-20 normaliser) and split into sentences
//    (`splitSentences`); every sentence is one cache entry per hop.
// 3. Translate: each sentence-hop is looked up in the cache (hit / join an in-flight
//    request / claim). Claimed ones go to the provider as one batch, chunked to its limits.
//    - Direct routes (one hop): all blocks of that route in one batch, in reading order.
//    - Pivot routes (`ja → en → de`): block by block in reading order, each block's hop 1
//      then hop 2, so the first block shows up first instead of after every hop-1 sentence
//      (Bergamot runs requests one at a time anyway).
// 4. Emit: after every sentence, the block's text is the translated sentences so far plus
//    the remaining sentences' source text (snip-popup.md §8 "Streaming granularity").
//    Partials (streaming providers) only show for the last hop.
//
// The shared batch request is cancelled only when no caller waits for any of its sentences
// (GLIM-20 single-flight); this run's own signal always stops this run promptly.

import type { BlockId } from "../block.ts";
import { normaliseSegment } from "../cache/normalise.ts";
import type { CachedTranslation, Flight, TranslationCache } from "../cache/translation-cache.ts";
import type { LanguageCode } from "../language/code.ts";
import { abortable, ProviderError, type ProviderErrorInfo, throwIfAborted } from "../providers/errors.ts";
import { type Provenance, provenanceOf } from "../providers/provenance.ts";
import { type PackRow, packRows, segmentFailureKind, type TranslationReadiness } from "../providers/readiness.ts";
import { routeTranslation } from "../providers/routing.ts";
import {
	chunkSegments,
	routeFingerprint,
	routeVia,
	type TranslationHop,
	type TranslationProvider,
} from "../providers/translation.ts";
import { joinSentences, type SentencePiece, splitSentences } from "../text/sentences.ts";
import type { BlockFailure, BlockTranslation, RecognisedBlock } from "./events.ts";

export interface TranslationPlanInput {
	/** Translate-class blocks (others are ignored), in reading order. */
	readonly blocks: readonly RecognisedBlock[];
	readonly to: LanguageCode;
	readonly chain: readonly TranslationProvider[];
	/** Download state for pairs that need a pack (the app's `TranslationPacks.readiness`). */
	readonly readinessOf: (from: LanguageCode, to: LanguageCode) => TranslationReadiness;
}

interface Route {
	readonly provider: TranslationProvider;
	readonly hops: readonly TranslationHop[];
}

export interface TranslationPlan {
	readonly to: LanguageCode;
	readonly routed: readonly { readonly block: RecognisedBlock; readonly from: LanguageCode; readonly route: Route }[];
	readonly packs: readonly PackRow[];
	/** Blocks waiting for a pack download. */
	readonly waiting: ReadonlySet<BlockId>;
	/** Blocks no provider can ever translate: final failures. */
	readonly unsupported: readonly BlockTranslation[];
}

export function planTranslation(input: TranslationPlanInput): TranslationPlan {
	const { to, chain } = input;
	const routes = new Map<string, Route | null>();
	const routed: TranslationPlan["routed"][number][] = [];
	const notReady: { id: string; from: LanguageCode }[] = [];
	const unsupported: BlockTranslation[] = [];
	for (const block of input.blocks) {
		if (block.cls !== "translate" || !block.lang) continue;
		const from = block.lang;
		let route = routes.get(from);
		if (route === undefined) {
			const r = routeTranslation(chain, from, to);
			route = r.status === "ready" ? { provider: r.provider, hops: r.support.hops } : null;
			routes.set(from, route);
		}
		if (route) {
			routed.push({ block, from, route });
			continue;
		}
		if (input.readinessOf(from, to).state === "unsupported") {
			const error = new ProviderError("unsupported-language", `no provider translates ${from} → ${to}`).toInfo();
			unsupported.push({
				blockId: block.id,
				text: block.text,
				final: true,
				failure: { kind: "unsupported", error },
				from,
				to,
				via: [],
				provider: null,
			});
		} else notReady.push({ id: block.id, from });
	}
	const packs = packRows(notReady, (from) => input.readinessOf(from, to));
	const waiting = new Set(packs.flatMap((r) => r.segmentIds));
	// Readiness said "not unsupported" but produced no row (e.g. it became ready meanwhile):
	// those blocks are neither waiting nor routed; report them as unsupported for this run.
	for (const { id, from } of notReady) {
		if (waiting.has(id)) continue;
		const block = input.blocks.find((b) => b.id === id);
		if (!block) continue;
		const error = new ProviderError("not-ready", `no ready provider for ${from} → ${to}`).toInfo();
		unsupported.push({
			blockId: id,
			text: block.text,
			final: true,
			failure: { kind: "failed", error },
			from,
			to,
			via: [],
			provider: null,
		});
	}
	return { to, routed, packs, waiting, unsupported };
}

export interface ExecuteOptions {
	readonly cache: TranslationCache;
	readonly signal?: AbortSignal;
	/** Retranslate: skip cached entries and overwrite them. */
	readonly bypassCache?: boolean;
	readonly now: () => number;
	readonly emit: (translation: BlockTranslation) => void;
}

interface SegmentRef {
	readonly id: string;
	readonly state: BlockState;
	readonly index: number;
}

type HopOutcome =
	| { readonly ok: true; readonly text: string; readonly remembered: boolean }
	| { readonly ok: false; readonly error: ProviderErrorInfo };

class BlockState {
	readonly pieces: readonly SentencePiece[];
	readonly outputs: (string | null)[];
	readonly partials: (string | null)[];
	readonly settled: boolean[];
	failure: BlockFailure | null = null;
	remembered = true;
	remaining: number;

	constructor(
		readonly block: RecognisedBlock,
		readonly from: LanguageCode,
		readonly route: Route,
		readonly to: LanguageCode,
	) {
		const normalised = normaliseSegment(block.text);
		this.pieces = splitSentences(normalised, from);
		this.outputs = this.pieces.map(() => null);
		this.partials = this.pieces.map(() => null);
		this.settled = this.pieces.map(() => false);
		this.remaining = this.pieces.length;
	}

	snapshot(): BlockTranslation {
		const final = this.remaining === 0;
		const shown = this.pieces.map((p, i) => this.outputs[i] ?? this.partials[i] ?? p.text);
		const provider: Provenance = provenanceOf(this.route.provider.info, routeFingerprint(this.route.hops));
		return {
			blockId: this.block.id,
			text: this.pieces.length === 0 ? this.block.text : joinSentences(shown, this.pieces, this.to),
			final,
			failure: this.failure,
			from: this.from,
			to: this.to,
			via: routeVia(this.route.hops),
			provider: final && this.remembered && this.failure === null ? { ...provider, remembered: true } : provider,
		};
	}
}

/** Run a plan. Resolves with every routed block's final translation; rejects only with `cancelled`. */
export async function executeTranslation(
	plan: TranslationPlan,
	options: ExecuteOptions,
): Promise<Map<BlockId, BlockTranslation>> {
	const { signal } = options;
	throwIfAborted(signal);
	const results = new Map<BlockId, BlockTranslation>();
	const emit = (state: BlockState) => {
		if (signal?.aborted) return;
		const snapshot = state.snapshot();
		if (snapshot.final) results.set(snapshot.blockId, snapshot);
		options.emit(snapshot);
	};

	// Group blocks by provider route.
	const groups = new Map<string, BlockState[]>();
	for (const { block, from, route } of plan.routed) {
		const state = new BlockState(block, from, route, plan.to);
		if (state.pieces.length === 0) {
			state.remaining = 0;
			emit(state);
			continue;
		}
		const key = `${route.provider.info.id}|${route.hops.map((h) => `${h.from}>${h.to}`).join(",")}`;
		const list = groups.get(key);
		if (list) list.push(state);
		else groups.set(key, [state]);
	}

	const settle = (ref: SegmentRef, outcome: HopOutcome) => {
		const { state, index } = ref;
		if (state.settled[index]) return;
		state.settled[index] = true;
		state.remaining--;
		if (outcome.ok) {
			state.outputs[index] = outcome.text;
			if (!outcome.remembered) state.remembered = false;
		} else {
			state.remembered = false;
			state.failure ??= { kind: segmentFailureKind(outcome.error), error: outcome.error };
		}
		emit(state);
	};

	const runGroup = async (states: BlockState[]) => {
		const route = states[0]?.route;
		if (!route) return;
		const units = route.hops.length === 1 ? [states] : states.map((s) => [s]);
		for (const unit of units) {
			let current: { ref: SegmentRef; text: string }[] = unit.flatMap((state) =>
				state.pieces.map((p, index) => ({ ref: { id: `${state.block.id}#${index}`, state, index }, text: p.text })),
			);
			for (let h = 0; h < route.hops.length && current.length > 0; h++) {
				const hop = route.hops[h] as TranslationHop;
				const last = h === route.hops.length - 1;
				const next: { ref: SegmentRef; text: string }[] = [];
				await runHop(route.provider, hop, current, {
					...options,
					onPartial: last
						? (ref, text) => {
								if (ref.state.settled[ref.index]) return;
								ref.state.partials[ref.index] = text;
								emit(ref.state);
							}
						: undefined,
					onResult: (ref, outcome) => {
						if (!outcome.ok || last) {
							settle(ref, outcome);
							return;
						}
						if (!outcome.remembered) ref.state.remembered = false;
						next.push({ ref, text: normaliseSegment(outcome.text) });
					},
				});
				// Keep reading order for the next hop's batch.
				next.sort((a, b) => order(a.ref) - order(b.ref));
				current = next;
			}
		}
	};

	await Promise.all([...groups.values()].map(runGroup));
	return results;
}

const order = (ref: SegmentRef) => ref.state.block.order * 10_000 + ref.index;

interface HopOptions extends ExecuteOptions {
	readonly onPartial: ((ref: SegmentRef, text: string) => void) | undefined;
	readonly onResult: (ref: SegmentRef, outcome: HopOutcome) => void;
}

/** One hop for a list of sentences: cache hits, joins, and one (chunked) provider batch for the rest. */
async function runHop(
	provider: TranslationProvider,
	hop: TranslationHop,
	items: readonly { ref: SegmentRef; text: string }[],
	options: HopOptions,
): Promise<void> {
	const { cache, signal, bypassCache = false } = options;
	const waits: Promise<void>[] = [];
	const claimed: { ref: SegmentRef; text: string; flight: Flight }[] = [];
	for (const item of items) {
		const key = { text: item.text, from: hop.from, to: hop.to, fingerprint: hop.fingerprint };
		const found = cache.lookup(key, { ...(signal ? { signal } : {}), bypass: bypassCache });
		if (found.kind === "hit") {
			options.onResult(item.ref, { ok: true, text: found.value.text, remembered: true });
		} else if (found.kind === "pending") {
			waits.push(
				found.promise.then(
					(value) => options.onResult(item.ref, { ok: true, text: value.text, remembered: false }),
					(error: unknown) => {
						const e = ProviderError.from(error);
						if (e.code === "cancelled") throw e;
						options.onResult(item.ref, { ok: false, error: e.toInfo() });
					},
				),
			);
		} else claimed.push({ ...item, flight: found.flight });
	}

	const byId = new Map(claimed.map((c) => [c.ref.id, c]));
	const batches = chunkSegments(claimed, provider.capabilities);
	const runBatches = async () => {
		for (const batch of batches) {
			// Flights whose waiters all left were failed (cancelled) already; skip them. A batch is
			// still sent when another run joined one of its sentences, even if this run stopped.
			const live = batch.filter((c) => !c.flight.settled);
			if (live.length === 0) continue;
			// The shared request stops only when every sentence in it lost all its waiters.
			const controller = new AbortController();
			const check = () => {
				if (live.every((c) => c.flight.settled || c.flight.signal.aborted)) controller.abort();
			};
			for (const c of live) c.flight.signal.addEventListener("abort", check, { once: true });
			check();
			try {
				const request = { segments: live.map((c) => ({ id: c.ref.id, text: c.text, from: hop.from })), to: hop.to };
				for await (const event of provider.translate(request, { signal: controller.signal })) {
					const c = byId.get(event.id);
					if (!c || c.flight.settled) continue;
					if (event.type === "partial") {
						if (!c.flight.signal.aborted) options.onPartial?.(c.ref, event.text);
					} else if (event.type === "done") {
						const value: CachedTranslation = {
							text: event.translation.text,
							provider: event.translation.provider,
							createdAt: options.now(),
						};
						c.flight.complete(value);
						if (!signal?.aborted) options.onResult(c.ref, { ok: true, text: value.text, remembered: false });
					} else {
						c.flight.fail(event.error);
						if (!signal?.aborted) options.onResult(c.ref, { ok: false, error: event.error });
					}
				}
			} catch (error) {
				const e = ProviderError.from(error, provider.info.id);
				for (const c of live) c.flight.fail(e);
				if (e.code !== "cancelled" && !signal?.aborted) {
					for (const c of live) options.onResult(c.ref, { ok: false, error: e.toInfo() });
				}
			} finally {
				for (const c of live) c.flight.signal.removeEventListener("abort", check);
			}
			for (const c of live) {
				if (c.flight.settled) continue;
				const e = new ProviderError("internal", "provider returned no result for segment", {
					providerId: provider.info.id,
				});
				c.flight.fail(e);
				if (!signal?.aborted) options.onResult(c.ref, { ok: false, error: e.toInfo() });
			}
		}
	};
	// This run stops promptly on its own signal, even while a shared request keeps going.
	await abortable(
		Promise.all([runBatches(), ...waits]).then(() => undefined),
		signal,
	);
}
