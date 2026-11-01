// GLIM-20: the in-memory translation cache. One LRU of translated segments (per hop),
// bounded by bytes and entries, with single-flight de-duplication of in-flight requests.
//
// - Memory only, never persisted. JavaScript strings can't be zeroed: "cleared" means
//   "dropped from Glimpse's memory", not "securely erased" (GLIM-20 Privacy 5).
// - Only successful, complete output is written: callers `complete()` a flight with a
//   provider's `done` result; errors, cancellations, partials and empty output never land.
// - Single-flight: a second lookup for a key that is already being translated joins that
//   request instead of firing another. A joiner whose own signal fires detaches; the shared
//   request is only cancelled (its `signal` fires) once nobody is waiting for it.
// - `clear()` also stops in-flight results from being written afterwards (generation bump),
//   so "Clear translation cache" during a translation really leaves nothing behind.
// - A non-storing instance (`store: false`) is the Private Snip cache: no reads, no writes,
//   single-flight within that one cache only.

import { ProviderError, type ProviderErrorInfo } from "../providers/errors.ts";
import type { Provenance, ProviderId } from "../providers/provenance.ts";
import { keyHash, keyIdentity, type TranslationKey } from "./key.ts";

/** What the cache stores for one segment and hop. */
export interface CachedTranslation {
	readonly text: string;
	/** Who produced it (hop-level provenance). Drives the cloud badge, even when remembered. */
	readonly provider: Provenance;
	/** Epoch ms. */
	readonly createdAt: number;
}

export type CacheClearReason =
	| "user"
	| "lock"
	| "sleep"
	| "idle"
	| "key-change"
	| "model-update"
	| "private-off"
	| "session-end";

export interface CacheStats {
	readonly entries: number;
	readonly bytes: number;
	readonly hits: number;
	readonly misses: number;
	/** Lookups that joined an in-flight request. */
	readonly joins: number;
	readonly writes: number;
	readonly evictions: number;
	readonly inFlight: number;
}

export interface CacheLimits {
	/** Default 16 MB (GLIM-20). */
	readonly maxBytes?: number;
	/** Default 20,000 entries (GLIM-20). */
	readonly maxEntries?: number;
}

export interface TranslationCacheOptions extends CacheLimits {
	/** False: never read or write entries (Private Snip). Default true. */
	readonly store?: boolean;
	/** Diagnostics name ("app", "private-live-3"). */
	readonly name?: string;
}

export const DEFAULT_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_CACHE_MAX_ENTRIES = 20_000;

/** Rough per-entry overhead in bytes (map slot, entry object, provenance), GLIM-20 estimate. */
const ENTRY_OVERHEAD = 320;

/** A claimed lookup: the caller translates the segment and settles the flight. */
export interface Flight {
	/** Fires once nobody waits for this result any more: stop the work if you can. */
	readonly signal: AbortSignal;
	readonly settled: boolean;
	/** Successful, complete output: resolves joiners and writes the entry. */
	complete(value: CachedTranslation): void;
	/** Failure or cancellation: joiners get the error; nothing is written. */
	fail(error: ProviderErrorInfo | ProviderError): void;
}

export type CacheLookup =
	/** Served from memory; `value.provider.remembered` is true. */
	| { readonly kind: "hit"; readonly value: CachedTranslation }
	/** Someone is already translating it. Rejects with `cancelled` when the caller's signal fires. */
	| { readonly kind: "pending"; readonly promise: Promise<CachedTranslation> }
	/** Nobody has it: translate and settle the flight. */
	| { readonly kind: "claimed"; readonly flight: Flight };

export interface LookupOptions {
	/** The caller's cancellation. Aborting detaches this caller from a shared request. */
	readonly signal?: AbortSignal;
	/** Skip the stored entry and any in-flight request ("Retranslate"); the result overwrites. */
	readonly bypass?: boolean;
}

interface Entry {
	readonly identity: string;
	readonly text: string;
	readonly value: CachedTranslation;
	readonly bytes: number;
}

const remembered = (value: CachedTranslation): CachedTranslation => ({
	...value,
	provider: { ...value.provider, remembered: true },
});

const cancelled = () => new ProviderError("cancelled", "cancelled");

class PendingFlight implements Flight {
	readonly #controller = new AbortController();
	readonly promise: Promise<CachedTranslation>;
	#resolve!: (value: CachedTranslation) => void;
	#reject!: (error: unknown) => void;
	#waiters = 0;
	#settled = false;

	constructor(
		readonly hash: string,
		readonly key: TranslationKey,
		readonly generation: number,
		private readonly onSettle: (flight: PendingFlight, value: CachedTranslation | null) => void,
	) {
		this.promise = new Promise<CachedTranslation>((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
		// Orphaned flights reject with nobody listening; that must not be an unhandled rejection.
		this.promise.catch(() => {});
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	get settled(): boolean {
		return this.#settled;
	}

	/** Count a waiter until it settles or its signal fires. */
	addWaiter(signal: AbortSignal | undefined): void {
		this.#waiters++;
		if (!signal) return;
		const onAbort = () => this.#leave();
		signal.addEventListener("abort", onAbort, { once: true });
		this.promise.then(
			() => signal.removeEventListener("abort", onAbort),
			() => signal.removeEventListener("abort", onAbort),
		);
	}

	#leave(): void {
		if (this.#settled) return;
		this.#waiters--;
		if (this.#waiters > 0) return;
		this.#controller.abort();
		this.fail(cancelled());
	}

	complete(value: CachedTranslation): void {
		if (this.#settled) return;
		this.#settled = true;
		this.onSettle(this, value);
		this.#resolve(value);
	}

	fail(error: ProviderErrorInfo | ProviderError): void {
		if (this.#settled) return;
		this.#settled = true;
		this.onSettle(this, null);
		this.#reject(error instanceof ProviderError ? error : ProviderError.fromInfo(error));
	}
}

/** Joiner's view of a shared flight: rejects with `cancelled` when its own signal fires. */
function joined(flight: PendingFlight, signal: AbortSignal | undefined): Promise<CachedTranslation> {
	flight.addWaiter(signal);
	if (!signal) return flight.promise;
	return new Promise<CachedTranslation>((resolve, reject) => {
		if (signal.aborted) {
			reject(cancelled());
			return;
		}
		const onAbort = () => reject(cancelled());
		signal.addEventListener("abort", onAbort, { once: true });
		flight.promise.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}

export class TranslationCache {
	readonly name: string;
	readonly store: boolean;
	readonly #maxBytes: number;
	readonly #maxEntries: number;
	readonly #entries = new Map<string, Entry>();
	readonly #pending = new Map<string, PendingFlight>();
	#bytes = 0;
	#generation = 0;
	#hits = 0;
	#misses = 0;
	#joins = 0;
	#writes = 0;
	#evictions = 0;

	constructor(options: TranslationCacheOptions = {}) {
		this.name = options.name ?? "cache";
		this.store = options.store ?? true;
		this.#maxBytes = options.maxBytes ?? DEFAULT_CACHE_MAX_BYTES;
		this.#maxEntries = options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
	}

	/** A stored entry (marked remembered), or undefined. Counts a hit or miss. */
	get(key: TranslationKey): CachedTranslation | undefined {
		if (!this.store) {
			this.#misses++;
			return undefined;
		}
		const hash = keyHash(key);
		const entry = this.#entries.get(hash);
		if (!entry || entry.text !== key.text || entry.identity !== keyIdentity(key)) {
			this.#misses++;
			return undefined;
		}
		// LRU: re-insert to make it the most recent.
		this.#entries.delete(hash);
		this.#entries.set(hash, entry);
		this.#hits++;
		return remembered(entry.value);
	}

	/** Write validated, complete output. Empty text is ignored. */
	set(key: TranslationKey, value: CachedTranslation): void {
		if (!this.store || value.text.trim() === "") return;
		const hash = keyHash(key);
		const existing = this.#entries.get(hash);
		if (existing) {
			this.#entries.delete(hash);
			this.#bytes -= existing.bytes;
		}
		const { remembered: _drop, ...provider } = value.provider;
		const stored: CachedTranslation = { ...value, provider };
		const bytes =
			2 * (key.text.length + value.text.length + provider.modelRevision.length + provider.name.length) + ENTRY_OVERHEAD;
		this.#entries.set(hash, { identity: keyIdentity(key), text: key.text, value: stored, bytes });
		this.#bytes += bytes;
		this.#writes++;
		this.#evict();
	}

	/**
	 * Hit, join an in-flight request, or claim the key. A claimant must settle its flight
	 * (`complete` or `fail`); its own `signal` counts as a waiter like any joiner's.
	 */
	lookup(key: TranslationKey, options: LookupOptions = {}): CacheLookup {
		const { signal, bypass = false } = options;
		if (!bypass) {
			const hit = this.get(key);
			if (hit) return { kind: "hit", value: hit };
		}
		const hash = keyHash(key);
		const existing = bypass ? undefined : this.#pending.get(hash);
		if (existing && !existing.settled && !existing.signal.aborted) {
			this.#joins++;
			return { kind: "pending", promise: joined(existing, signal) };
		}
		const flight = new PendingFlight(hash, key, this.#generation, (f, value) => this.#settle(f, value));
		flight.addWaiter(signal);
		// A bypassing flight doesn't replace one others may still join.
		if (!this.#pending.has(hash) || !bypass) this.#pending.set(hash, flight);
		if (signal?.aborted) flight.fail(cancelled());
		return { kind: "claimed", flight };
	}

	/** `lookup` + run for a single key (GLIM-20 sketch). `run` gets the shared signal. */
	async getOrTranslate(
		key: TranslationKey,
		run: (signal: AbortSignal) => Promise<CachedTranslation>,
		options: LookupOptions = {},
	): Promise<CachedTranslation> {
		const result = this.lookup(key, options);
		if (result.kind === "hit") return result.value;
		if (result.kind === "pending") return result.promise;
		const { flight } = result;
		try {
			const value = await run(flight.signal);
			flight.complete(value);
			return value;
		} catch (error) {
			const e = ProviderError.from(error);
			flight.fail(e);
			throw e;
		}
	}

	#settle(flight: PendingFlight, value: CachedTranslation | null): void {
		if (this.#pending.get(flight.hash) === flight) this.#pending.delete(flight.hash);
		if (value && flight.generation === this.#generation) this.set(flight.key, value);
	}

	#evict(): void {
		while (this.#entries.size > this.#maxEntries || (this.#bytes > this.#maxBytes && this.#entries.size > 0)) {
			const oldest = this.#entries.keys().next();
			if (oldest.done) break;
			const entry = this.#entries.get(oldest.value);
			this.#entries.delete(oldest.value);
			this.#bytes -= entry?.bytes ?? 0;
			this.#evictions++;
		}
	}

	/** Drop every entry a provider produced (model update, key change). */
	dropProvider(providerId: ProviderId): number {
		let dropped = 0;
		for (const [hash, entry] of this.#entries) {
			if (entry.value.provider.providerId !== providerId) continue;
			this.#entries.delete(hash);
			this.#bytes -= entry.bytes;
			dropped++;
		}
		return dropped;
	}

	/** Drop everything, and stop in-flight results from being written later. */
	clear(_reason: CacheClearReason): void {
		this.#entries.clear();
		this.#bytes = 0;
		this.#generation++;
	}

	/** Counters only, never text (GLIM-20 "Stats"). */
	stats(): CacheStats {
		return {
			entries: this.#entries.size,
			bytes: this.#bytes,
			hits: this.#hits,
			misses: this.#misses,
			joins: this.#joins,
			writes: this.#writes,
			evictions: this.#evictions,
			inFlight: this.#pending.size,
		};
	}
}
