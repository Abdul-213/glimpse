// Host side of the Bergamot inference Worker: spawns it on demand, loads and warms packs,
// keeps at most `maxLoadedPacks` of them (least recently used goes first), streams
// per-sentence results, cancels, and terminates the Worker after `idleMs` without work to
// give its memory back (a WASM heap never shrinks, so unloading a pack only makes room for
// the next one inside it; GLIM-17 measured ~0.1-0.4 GB per loaded pack).
//
// All Worker operations are serialised: Bergamot is single-threaded, so a second request
// would only queue inside the Worker anyway, and serialising here keeps the LRU exact.
import { abortable, ProviderError, throwIfAborted } from "@glimpse/core";
import type { HostMessage, LoadResult, WorkerMessage, WorkerPort, WorkerSpawner, WorkerStats } from "./protocol.ts";

/** One loaded model: `key` changes when the pack's version does, so an update reloads it. */
export interface PackRef {
	readonly key: string;
	readonly dir: string;
}

export interface EngineOptions {
	readonly spawn: WorkerSpawner;
	readonly runtimeDir: string;
	/** Packs kept loaded at once. A pivot route needs two. Default 4. */
	readonly maxLoadedPacks?: number;
	/** Terminate the Worker after this long without a request. 0 = never. Default 5 min. */
	readonly idleMs?: number;
	readonly providerId?: string;
	/** Diagnostics: pack load and warm-up times, evictions, worker restarts. */
	readonly onEvent?: (event: EngineEvent) => void;
}

export type EngineEvent =
	| { readonly type: "runtime-loaded"; readonly ms: number }
	| { readonly type: "pack-loaded"; readonly key: string; readonly loadMs: number; readonly warmupMs: number }
	| { readonly type: "pack-unloaded"; readonly key: string }
	| { readonly type: "worker-stopped"; readonly reason: "idle" | "crash" | "dispose" };

interface Pending {
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly onSentence?: (index: number, text: string) => void;
}

export const DEFAULT_MAX_LOADED_PACKS = 4;
export const DEFAULT_IDLE_MS = 5 * 60_000;

export class BergamotEngine {
	readonly #opts: EngineOptions;
	readonly #maxLoaded: number;
	readonly #providerId: string;
	#worker: WorkerPort | null = null;
	#runtimeReady: Promise<void> | null = null;
	/** Loaded pack keys, least recently used first. */
	readonly #loaded = new Map<string, PackRef>();
	readonly #pending = new Map<number, Pending>();
	#nextId = 1;
	#chain: Promise<unknown> = Promise.resolve();
	#idleTimer: ReturnType<typeof setTimeout> | null = null;
	#busy = 0;
	#disposed = false;

	constructor(options: EngineOptions) {
		this.#opts = options;
		this.#maxLoaded = Math.max(2, options.maxLoadedPacks ?? DEFAULT_MAX_LOADED_PACKS);
		this.#providerId = options.providerId ?? "bergamot";
	}

	/** Keys of the packs loaded right now, least recently used first. */
	get loaded(): string[] {
		return [...this.#loaded.keys()];
	}

	get running(): boolean {
		return this.#worker !== null;
	}

	/** Spawn the Worker and instantiate the WASM runtime (idempotent). */
	start(signal?: AbortSignal): Promise<void> {
		return abortable(
			this.#serial(() => this.#ensureRuntime()),
			signal,
			this.#providerId,
		);
	}

	/** Load (and warm) packs ahead of a request, e.g. the user's usual route at app start. */
	preload(packs: readonly PackRef[], signal?: AbortSignal): Promise<void> {
		return abortable(
			this.#serial(async () => {
				await this.#ensureRuntime();
				await this.#ensureLoaded(packs);
			}),
			signal,
			this.#providerId,
		);
	}

	/**
	 * Translate sentences over a route of one pack (direct) or two (pivot). `onSentence` is
	 * called as each sentence finishes, in order. Rejects `cancelled` as soon as the signal
	 * fires; the Worker stops after the sentence it is on.
	 */
	translate(
		route: readonly PackRef[],
		sentences: readonly string[],
		onSentence: (index: number, text: string) => void,
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal, this.#providerId);
		if (route.length < 1 || route.length > 2) return Promise.reject(new RangeError("route needs one or two packs"));
		let requestId = 0;
		const run = this.#serial(async () => {
			throwIfAborted(signal, this.#providerId);
			await this.#ensureRuntime();
			await this.#ensureLoaded(route);
			throwIfAborted(signal, this.#providerId);
			if (sentences.length === 0) return;
			requestId = this.#nextId++;
			await this.#request(
				{ type: "translate", id: requestId, route: route.map((p) => p.key), sentences },
				(index, text) => {
					if (!signal?.aborted) onSentence(index, text);
				},
			);
		});
		const onAbort = () => {
			if (requestId !== 0 && this.#pending.has(requestId)) this.#post({ type: "cancel", id: requestId });
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		return abortable(run, signal, this.#providerId).finally(() => signal?.removeEventListener("abort", onAbort));
	}

	async stats(): Promise<WorkerStats | null> {
		if (!this.#worker) return null;
		return (await this.#serial(() => this.#request({ type: "stats", id: this.#nextId++ }))) as WorkerStats;
	}

	/** Terminate the Worker now (frees all its memory). The next request respawns it. */
	stop(reason: "idle" | "crash" | "dispose" = "idle"): void {
		const worker = this.#worker;
		this.#worker = null;
		this.#runtimeReady = null;
		this.#loaded.clear();
		this.#clearIdle();
		if (worker) {
			worker.onmessage = null;
			worker.onerror = null;
			worker.terminate();
			this.#opts.onEvent?.({ type: "worker-stopped", reason });
		}
		const error = new ProviderError(
			reason === "crash" ? "internal" : "not-ready",
			reason === "crash" ? "translation worker crashed" : "translation worker stopped",
			{ providerId: this.#providerId },
		);
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.stop("dispose");
	}

	// --- internals -------------------------------------------------------------------

	/** Run `fn` after every earlier operation settled; the idle timer only runs while nothing is queued. */
	#serial<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#disposed)
			return Promise.reject(new ProviderError("not-ready", "disposed", { providerId: this.#providerId }));
		this.#busy++;
		this.#clearIdle();
		const result = this.#chain.then(fn);
		this.#chain = result.then(
			() => this.#settled(),
			() => this.#settled(),
		);
		return result;
	}

	#settled(): void {
		this.#busy--;
		if (this.#busy === 0) this.#armIdle();
	}

	#armIdle(): void {
		const ms = this.#opts.idleMs ?? DEFAULT_IDLE_MS;
		if (ms <= 0 || !this.#worker || this.#disposed) return;
		this.#clearIdle();
		this.#idleTimer = setTimeout(() => {
			if (this.#busy === 0) this.stop("idle");
		}, ms);
		// Don't keep a process (tests, CLI) alive just for the idle timer.
		(this.#idleTimer as { unref?: () => void }).unref?.();
	}

	#clearIdle(): void {
		if (this.#idleTimer) clearTimeout(this.#idleTimer);
		this.#idleTimer = null;
	}

	#spawn(): WorkerPort {
		const worker = this.#opts.spawn();
		worker.onmessage = (event) => this.#onMessage(event.data);
		worker.onerror = (event) => {
			event.preventDefault?.();
			if (this.#worker === worker) this.stop("crash");
		};
		this.#worker = worker;
		return worker;
	}

	#ensureRuntime(): Promise<void> {
		if (!this.#runtimeReady) {
			if (!this.#worker) this.#spawn();
			const ready = this.#request({ type: "init", id: this.#nextId++, runtimeDir: this.#opts.runtimeDir }).then(
				(result) => {
					this.#opts.onEvent?.({ type: "runtime-loaded", ms: (result as { ms: number }).ms });
				},
			);
			this.#runtimeReady = ready;
			ready.catch(() => {
				if (this.#runtimeReady === ready) this.stop("crash");
			});
		}
		return this.#runtimeReady;
	}

	async #ensureLoaded(packs: readonly PackRef[]): Promise<void> {
		const keep = new Set(packs.map((p) => p.key));
		for (const pack of packs) {
			if (this.#loaded.has(pack.key)) {
				// Touch: move to the most-recent end.
				this.#loaded.delete(pack.key);
				this.#loaded.set(pack.key, pack);
				continue;
			}
			// Make room first so peak memory stays at maxLoaded packs.
			for (const key of [...this.#loaded.keys()]) {
				if (this.#loaded.size < this.#maxLoaded) break;
				if (keep.has(key)) continue;
				await this.#request({ type: "unload", id: this.#nextId++, key });
				this.#loaded.delete(key);
				this.#opts.onEvent?.({ type: "pack-unloaded", key });
			}
			const result = (await this.#request({
				type: "load",
				id: this.#nextId++,
				key: pack.key,
				dir: pack.dir,
			})) as LoadResult;
			this.#loaded.set(pack.key, pack);
			this.#opts.onEvent?.({ type: "pack-loaded", key: pack.key, ...result });
		}
	}

	#request(message: HostMessage, onSentence?: (index: number, text: string) => void): Promise<unknown> {
		const worker = this.#worker;
		if (!worker) {
			return Promise.reject(
				new ProviderError("not-ready", "translation worker not running", { providerId: this.#providerId }),
			);
		}
		return new Promise((resolve, reject) => {
			this.#pending.set(message.id, onSentence ? { resolve, reject, onSentence } : { resolve, reject });
			worker.postMessage(message);
		});
	}

	#post(message: HostMessage): void {
		this.#worker?.postMessage(message);
	}

	#onMessage(message: WorkerMessage): void {
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		if (message.type === "sentence") {
			pending.onSentence?.(message.index, message.text);
			return;
		}
		this.#pending.delete(message.id);
		if (message.type === "ok") pending.resolve(message.result);
		else pending.reject(new ProviderError("internal", message.message, { providerId: this.#providerId }));
	}
}
