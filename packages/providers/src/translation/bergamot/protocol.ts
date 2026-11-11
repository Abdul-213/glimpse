// Messages between the Bergamot host (engine.ts, in the main Bun worker) and the inference
// Worker (worker.ts). Plain data only. Every request has an `id`; the worker answers each
// with exactly one `ok` or `error`, after zero or more `sentence` events for a translate.

export type HostMessage =
	/** Instantiate the WASM runtime from `<runtimeDir>/bergamot-translator.{wasm,js}`. */
	| { readonly type: "init"; readonly id: number; readonly runtimeDir: string }
	/** Load the pack in `dir` (reads `pack.json`) under `key`, then translate one word to warm it. */
	| { readonly type: "load"; readonly id: number; readonly key: string; readonly dir: string }
	| { readonly type: "unload"; readonly id: number; readonly key: string }
	/** One key: direct model. Two keys: `translateViaPivoting` (both packs share this runtime). */
	| {
			readonly type: "translate";
			readonly id: number;
			readonly route: readonly string[];
			readonly sentences: readonly string[];
	  }
	/** Stop a running translate after the current sentence. No reply of its own. */
	| { readonly type: "cancel"; readonly id: number }
	| { readonly type: "stats"; readonly id: number };

export interface LoadResult {
	readonly loadMs: number;
	readonly warmupMs: number;
}

export interface WorkerStats {
	/** Size of the WASM heap (it only grows; terminating the Worker is what returns it). */
	readonly wasmHeapBytes: number;
	readonly loaded: readonly string[];
}

export type WorkerMessage =
	| { readonly type: "sentence"; readonly id: number; readonly index: number; readonly text: string }
	| { readonly type: "ok"; readonly id: number; readonly result?: LoadResult | WorkerStats | { readonly ms: number } }
	| { readonly type: "error"; readonly id: number; readonly message: string };

/** The part of a Bun `Worker` the host uses, so tests can drive the host with a fake. */
export interface WorkerPort {
	postMessage(message: HostMessage): void;
	onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	terminate(): void;
}

export type WorkerSpawner = () => WorkerPort;
