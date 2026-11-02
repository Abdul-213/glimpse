// Host side of the SMaLL-100 inference Worker (GLIM-100): spawns it on the first request (the
// model is ~0.6 GB on disk and ~1 GB in memory, so nothing loads at app start), streams
// per-sentence results, cancels, and terminates the Worker after `idleMs` without work to give
// the memory back. Operations are serialised: one sentence decodes at a time anyway, and the
// Worker would only queue a second request.
import { abortable, ProviderError, throwIfAborted } from "@glimpse/core";
import type {
	SentenceTiming,
	Small100HostMessage,
	Small100InitResult,
	Small100WorkerMessage,
	Small100WorkerPort,
	Small100WorkerSpawner,
} from "./protocol.ts";

export interface Small100EngineOptions {
	readonly spawn: Small100WorkerSpawner;
	/** The installed model folder. */
	readonly modelDir: string;
	/** onnxruntime intra-op threads. Default 4. */
	readonly threads?: number;
	/** Terminate the Worker after this long without a request. 0 = never. Default 2 min. */
	readonly idleMs?: number;
	readonly providerId?: string;
	readonly onEvent?: (event: Small100EngineEvent) => void;
}

export type Small100EngineEvent =
	| { readonly type: "model-loaded"; readonly ms: number }
	| { readonly type: "warmed"; readonly ms: number }
	| { readonly type: "sentence"; readonly timing: SentenceTiming }
	| { readonly type: "worker-stopped"; readonly reason: "idle" | "crash" | "dispose" };

/** Long idle timeouts keep ~1 GB resident for a model that serves the long tail only. */
export const SMALL100_DEFAULT_IDLE_MS = 2 * 60_000;
export const SMALL100_DEFAULT_THREADS = 4;

interface Pending {
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly onSentence?: (index: number, text: string, timing: SentenceTiming) => void;
}

export class Small100Engine {
	readonly #opts: Small100EngineOptions;
	readonly #providerId: string;
	#worker: Small100WorkerPort | null = null;
	#ready: Promise<Small100InitResult> | null = null;
	readonly #pending = new Map<number, Pending>();
	#nextId = 1;
	#chain: Promise<unknown> = Promise.resolve();
	#idleTimer: ReturnType<typeof setTimeout> | null = null;
	#busy = 0;
	#disposed = false;

	constructor(options: Small100EngineOptions) {
		this.#opts = options;
		this.#providerId = options.providerId ?? "small100";
	}

	get running(): boolean {
		return this.#worker !== null;
	}

	get modelDir(): string {
		return this.#opts.modelDir;
	}

	/** Load the model (spawning the Worker) and run one short sentence through it. */
	warmup(signal?: AbortSignal): Promise<void> {
		return abortable(
			this.#serial(async () => {
				await this.#ensureLoaded();
				const r = (await this.#request({ type: "warmup", id: this.#nextId++ })) as { ms: number };
				this.#opts.onEvent?.({ type: "warmed", ms: r.ms });
			}),
			signal,
			this.#providerId,
		);
	}

	/**
	 * Translate sentences `from → to` (M2M-100 codes). `onSentence` is called as each one
	 * finishes, in order. Rejects `cancelled` as soon as the signal fires; the Worker stops at
	 * its next decoder step.
	 */
	translate(
		from: string,
		to: string,
		sentences: readonly string[],
		onSentence: (index: number, text: string) => void,
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal, this.#providerId);
		let requestId = 0;
		const run = this.#serial(async () => {
			throwIfAborted(signal, this.#providerId);
			await this.#ensureLoaded();
			throwIfAborted(signal, this.#providerId);
			if (sentences.length === 0) return;
			requestId = this.#nextId++;
			await this.#request({ type: "translate", id: requestId, from, to, sentences }, (index, text, timing) => {
				this.#opts.onEvent?.({ type: "sentence", timing });
				if (!signal?.aborted) onSentence(index, text);
			});
		});
		const onAbort = () => {
			if (requestId !== 0 && this.#pending.has(requestId)) this.#post({ type: "cancel", id: requestId });
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		return abortable(run, signal, this.#providerId).finally(() => signal?.removeEventListener("abort", onAbort));
	}

	/** Terminate the Worker now (frees the model). The next request respawns it. */
	stop(reason: "idle" | "crash" | "dispose" = "idle"): void {
		const worker = this.#worker;
		this.#worker = null;
		this.#ready = null;
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

	#serial<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#disposed) {
			return Promise.reject(new ProviderError("not-ready", "disposed", { providerId: this.#providerId }));
		}
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
		const ms = this.#opts.idleMs ?? SMALL100_DEFAULT_IDLE_MS;
		if (ms <= 0 || !this.#worker || this.#disposed) return;
		this.#clearIdle();
		this.#idleTimer = setTimeout(() => {
			if (this.#busy === 0) this.stop("idle");
		}, ms);
		(this.#idleTimer as { unref?: () => void }).unref?.();
	}

	#clearIdle(): void {
		if (this.#idleTimer) clearTimeout(this.#idleTimer);
		this.#idleTimer = null;
	}

	#ensureLoaded(): Promise<Small100InitResult> {
		if (!this.#ready) {
			const worker = this.#opts.spawn();
			worker.onmessage = (event) => this.#onMessage(event.data);
			worker.onerror = (event) => {
				event.preventDefault?.();
				if (this.#worker === worker) this.stop("crash");
			};
			this.#worker = worker;
			const ready = this.#request({
				type: "init",
				id: this.#nextId++,
				modelDir: this.#opts.modelDir,
				threads: this.#opts.threads ?? SMALL100_DEFAULT_THREADS,
			}).then((result) => {
				const init = result as Small100InitResult;
				this.#opts.onEvent?.({ type: "model-loaded", ms: init.loadMs });
				return init;
			});
			this.#ready = ready;
			// A model that won't load (damaged file) mustn't leave a half-started Worker behind.
			ready.catch(() => {
				if (this.#ready === ready) this.stop("crash");
			});
		}
		return this.#ready;
	}

	#request(
		message: Small100HostMessage,
		onSentence?: (index: number, text: string, timing: SentenceTiming) => void,
	): Promise<unknown> {
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

	#post(message: Small100HostMessage): void {
		this.#worker?.postMessage(message);
	}

	#onMessage(message: Small100WorkerMessage): void {
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		if (message.type === "sentence") {
			pending.onSentence?.(message.index, message.text, message.timing);
			return;
		}
		this.#pending.delete(message.id);
		if (message.type === "ok") pending.resolve(message.result);
		else {
			const code = message.cancelled ? "cancelled" : "internal";
			pending.reject(new ProviderError(code, message.message, { providerId: this.#providerId }));
		}
	}
}
