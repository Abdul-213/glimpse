// Pipeline-side handle on the inference Worker: request/response with ids, per-job event
// callbacks, and crash handling (a dead worker rejects everything in flight).

import type { FromWorker, OcrJobResult, ToWorker, WithoutId } from "./protocol.ts";

/** The part of a Bun `Worker` the client uses, so tests and the app can spawn it their way. */
export interface WorkerLike {
	postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	terminate(): void;
}

export type SpawnWorker = () => WorkerLike;

/** Default spawner: the worker module next to this file. */
export const spawnOcrWorker: SpawnWorker = () =>
	new Worker(new URL("./worker.ts", import.meta.url).href) as unknown as WorkerLike;

export class WorkerFailure extends Error {
	constructor(
		readonly workerName: string,
		message: string,
	) {
		super(message);
		this.name = workerName === "AbortError" ? "AbortError" : "WorkerFailure";
	}
}

interface Pending {
	resolve(value: OcrJobResult | undefined): void;
	reject(error: Error): void;
	onEvent?: (event: FromWorker) => void;
}

export class OcrWorkerClient {
	readonly #worker: WorkerLike;
	readonly #pending = new Map<number, Pending>();
	#nextId = 1;
	#dead: Error | null = null;
	/** Called once if the worker dies (uncaught error). */
	onCrash: ((error: Error) => void) | null = null;

	constructor(spawn: SpawnWorker) {
		this.#worker = spawn();
		this.#worker.onmessage = (event: MessageEvent<FromWorker>) => this.#receive(event.data);
		this.#worker.onerror = (event: ErrorEvent) => {
			event.preventDefault?.();
			this.#fail(new Error(`OCR worker crashed: ${event.message || "unknown error"}`));
		};
	}

	#receive(msg: FromWorker): void {
		const p = this.#pending.get(msg.id);
		if (!p) return;
		if (msg.type === "ok") {
			this.#pending.delete(msg.id);
			p.resolve(msg.value);
		} else if (msg.type === "error") {
			this.#pending.delete(msg.id);
			p.reject(new WorkerFailure(msg.name, msg.message));
		} else p.onEvent?.(msg);
	}

	#fail(error: Error): void {
		if (this.#dead) return;
		this.#dead = error;
		for (const p of this.#pending.values()) p.reject(error);
		this.#pending.clear();
		this.onCrash?.(error);
	}

	/** Send a request; resolves with the worker's `ok` value. `onStart` receives the job id. */
	request(
		msg: WithoutId<ToWorker>,
		options: {
			readonly transfer?: ArrayBuffer[];
			readonly onEvent?: (event: FromWorker) => void;
			readonly onStart?: (id: number) => void;
		} = {},
	): Promise<OcrJobResult | undefined> {
		if (this.#dead) return Promise.reject(this.#dead);
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject, ...(options.onEvent ? { onEvent: options.onEvent } : {}) });
			options.onStart?.(id);
			this.#worker.postMessage({ ...msg, id }, options.transfer ?? []);
		});
	}

	/** Ask the worker to stop job `target` at its next check. Fire and forget. */
	cancel(target: number): void {
		if (this.#dead) return;
		this.#pending.delete(target);
		this.#worker.postMessage({ type: "cancel", id: 0, target } satisfies ToWorker);
	}

	terminate(): void {
		this.#fail(new Error("OCR worker terminated"));
		this.#worker.terminate();
	}
}
