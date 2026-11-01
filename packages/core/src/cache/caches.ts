// GLIM-20 cache scopes and wipe rules, as one object the app owns.
//
// - One app-wide cache shared by Snip and Live.
// - Private mode: the app-wide cache is neither read nor written. A Private Snip gets a
//   non-storing cache (it caches nothing); a Private Live session gets its own isolated
//   cache, dropped when the session ends or Private is turned off.
// - Wipes: `clear("user")` (tray, Settings) clears the app cache and every session cache;
//   after `idleMinutes` with no Snip or Live activity (an open Live session counts as
//   activity); on screen lock / system sleep (the app reports them with `clear`). `tick()`
//   also detects a system sleep on its own: if the wall clock jumped much further than the
//   tick interval, the machine was suspended, so the cache is wiped.
//
// Pure: time comes from an injected clock; the app calls `tick()` from a timer.

import { type CacheClearReason, type CacheLimits, type CacheStats, TranslationCache } from "./translation-cache.ts";

export interface TranslationCachesOptions extends CacheLimits {
	/** Epoch-ms clock (`Date.now`); tests pass a manual one. */
	readonly now: () => number;
	/** Wipe after this many idle minutes; 0 = only on quit. Default 15 (GLIM-20). */
	readonly idleMinutes?: number;
	/**
	 * How often the app calls `tick()`, in ms. A gap of more than `interval + sleepGapMs`
	 * between ticks means the system was asleep. Default 30 s / 60 s.
	 */
	readonly tickIntervalMs?: number;
	readonly sleepGapMs?: number;
	/** Told about every wipe (for the log; never contains text). */
	readonly onClear?: (reason: CacheClearReason, stats: CacheStats) => void;
}

/** A Live session's handle on its cache. */
export interface SessionCache {
	readonly cache: TranslationCache;
	readonly private: boolean;
	/** End the session: its private cache (if any) is dropped. Idempotent. */
	close(): void;
}

export class TranslationCaches {
	readonly app: TranslationCache;
	readonly #opts: TranslationCachesOptions;
	readonly #sessions = new Set<TranslationCache>();
	readonly #noStore = new TranslationCache({ store: false, name: "private-snip" });
	#openSessions = 0;
	#idleMs: number;
	#lastActivity: number;
	#lastTick: number;
	#sessionSeq = 0;

	constructor(options: TranslationCachesOptions) {
		this.#opts = options;
		this.app = new TranslationCache({ ...limits(options), name: "app" });
		this.#idleMs = (options.idleMinutes ?? 15) * 60_000;
		this.#lastActivity = options.now();
		this.#lastTick = this.#lastActivity;
	}

	/** Settings changed the idle wipe (minutes; 0 = only on quit). */
	setIdleMinutes(minutes: number): void {
		this.#idleMs = Math.max(0, minutes) * 60_000;
	}

	/** The cache for one Snip. Private: a cache that never stores anything. */
	forSnip(isPrivate: boolean): TranslationCache {
		this.noteActivity();
		return isPrivate ? this.#noStore : this.app;
	}

	/** Open a Live session's cache. Private sessions get an isolated one. */
	openSession(isPrivate: boolean): SessionCache {
		this.noteActivity();
		this.#openSessions++;
		let closed = false;
		const cache = isPrivate
			? new TranslationCache({ ...limits(this.#opts), name: `private-live-${++this.#sessionSeq}` })
			: this.app;
		if (isPrivate) this.#sessions.add(cache);
		return {
			cache,
			private: isPrivate,
			close: () => {
				if (closed) return;
				closed = true;
				this.#openSessions--;
				this.noteActivity();
				if (isPrivate) {
					cache.clear("session-end");
					this.#sessions.delete(cache);
				}
			},
		};
	}

	/** A Snip or Live frame happened. */
	noteActivity(): void {
		this.#lastActivity = this.#opts.now();
	}

	/** Wipe the app cache and every session cache. */
	clear(reason: CacheClearReason): void {
		const stats = this.app.stats();
		this.app.clear(reason);
		for (const cache of this.#sessions) cache.clear(reason);
		this.#opts.onClear?.(reason, stats);
	}

	/** Drop one provider's entries everywhere (model update, key change). */
	dropProvider(providerId: string): void {
		this.app.dropProvider(providerId);
		for (const cache of this.#sessions) cache.dropProvider(providerId);
	}

	/**
	 * Call every `tickIntervalMs`. Wipes after a detected sleep or the idle timeout.
	 * Returns the reason when it wiped, else null.
	 */
	tick(): CacheClearReason | null {
		const now = this.#opts.now();
		const interval = this.#opts.tickIntervalMs ?? 30_000;
		const gap = this.#opts.sleepGapMs ?? 60_000;
		const sinceTick = now - this.#lastTick;
		this.#lastTick = now;
		if (sinceTick > interval + gap) {
			this.clear("sleep");
			this.#lastActivity = now;
			return "sleep";
		}
		if (this.#openSessions > 0) {
			this.#lastActivity = now;
			return null;
		}
		if (this.#idleMs > 0 && now - this.#lastActivity >= this.#idleMs && this.app.stats().entries > 0) {
			this.clear("idle");
			this.#lastActivity = now;
			return "idle";
		}
		return null;
	}

	stats(): { readonly app: CacheStats; readonly privateSessions: number } {
		return { app: this.app.stats(), privateSessions: this.#sessions.size };
	}
}

const limits = (o: CacheLimits): CacheLimits => ({
	...(o.maxBytes === undefined ? {} : { maxBytes: o.maxBytes }),
	...(o.maxEntries === undefined ? {} : { maxEntries: o.maxEntries }),
});
