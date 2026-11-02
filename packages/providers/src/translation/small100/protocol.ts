// Messages between the SMaLL-100 host (engine.ts, in the app's Bun worker) and the inference
// Worker (worker.ts). Plain data only. Every request has an `id`; the Worker answers each with
// exactly one `ok` or `error`, after zero or more `sentence` events for a translate.

export type Small100HostMessage =
	/** Create the ONNX sessions and the tokenizer from the model folder. */
	| { readonly type: "init"; readonly id: number; readonly modelDir: string; readonly threads: number }
	/** One short sentence through both sessions, so the first real request is fast. */
	| { readonly type: "warmup"; readonly id: number }
	/** Translate sentences one by one; `from` / `to` are M2M-100 codes (`ja`, `sw`). */
	| {
			readonly type: "translate";
			readonly id: number;
			readonly from: string;
			readonly to: string;
			readonly sentences: readonly string[];
	  }
	/** Stop a running translate at the next decoder step. No reply of its own. */
	| { readonly type: "cancel"; readonly id: number };

export interface Small100InitResult {
	readonly loadMs: number;
	/** M2M-100 codes the tokenizer has language tokens for. */
	readonly languages: readonly string[];
}

export interface SentenceTiming {
	readonly encodeMs: number;
	readonly decodeMs: number;
	readonly tokens: number;
}

export type Small100WorkerMessage =
	| {
			readonly type: "sentence";
			readonly id: number;
			readonly index: number;
			readonly text: string;
			readonly timing: SentenceTiming;
	  }
	| { readonly type: "ok"; readonly id: number; readonly result?: Small100InitResult | { readonly ms: number } }
	| { readonly type: "error"; readonly id: number; readonly message: string; readonly cancelled?: boolean };

/** The part of a Bun `Worker` the host uses, so tests can drive the host with a fake. */
export interface Small100WorkerPort {
	postMessage(message: Small100HostMessage): void;
	onmessage: ((event: MessageEvent<Small100WorkerMessage>) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	terminate(): void;
}

export type Small100WorkerSpawner = () => Small100WorkerPort;
