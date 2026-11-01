// Model and resource lifecycle shared by OCR and translation providers.
//
//   idle ──init()──► loading ──► ready
//                        │  ├──► model-missing   (files not downloaded; GLIM-57 offers the download)
//                        │  ├──► needs-key       (cloud: no key in the keychain)
//                        │  └──► error           (engine failed to load)
//   any ──dispose()──► disposed  (terminal)
//
// `init()` may be called again from model-missing / needs-key / error (after a download,
// a key change, or to retry). Providers never download anything themselves: a missing
// model is reported, and the model manager fetches it with the user's consent (GLIM-85:
// a missing pack never silently goes to the network).

import type { ProviderErrorInfo } from "./errors.ts";

/** A downloadable file set a provider needs: a PaddleOCR model, a Bergamot pack. */
export interface ModelResource {
	/** Stable id the model manager understands, e.g. `bergamot:ja-en`, `paddleocr:ppocrv5-mobile`. */
	readonly id: string;
	/** Short human name: "Japanese → English". */
	readonly name: string;
	/** Download size, when known, for "Download Thai → English (31 MB)". */
	readonly bytes: number | null;
}

export type ProviderStatus =
	| { readonly state: "idle" }
	| { readonly state: "loading" }
	| { readonly state: "ready" }
	| { readonly state: "model-missing"; readonly missing: readonly ModelResource[] }
	| { readonly state: "needs-key" }
	| { readonly state: "error"; readonly error: ProviderErrorInfo }
	| { readonly state: "disposed" };

export type ProviderState = ProviderStatus["state"];

export type Unsubscribe = () => void;

export interface ProviderLifecycle {
	readonly status: ProviderStatus;
	/** Called after every status change. Returns an unsubscribe function. */
	onStatusChange(listener: (status: ProviderStatus) => void): Unsubscribe;
	/**
	 * Load models / check keys. Idempotent: concurrent calls share one load, and calling it
	 * when ready resolves immediately. Resolves with the resulting status; it only rejects
	 * with `ProviderError("cancelled")` when the signal fires.
	 */
	init(signal?: AbortSignal): Promise<ProviderStatus>;
	/**
	 * Optional: run a tiny inference so the first real request is fast (JIT, caches).
	 * Only valid when ready. Never required for correctness.
	 */
	warmup?(signal?: AbortSignal): Promise<void>;
	/** Free models, workers and sockets. Idempotent. Afterwards every call fails `not-ready`. */
	dispose(): Promise<void>;
}

/** A status value plus listeners: the bookkeeping every provider needs. */
export class StatusCell {
	#status: ProviderStatus;
	readonly #listeners = new Set<(status: ProviderStatus) => void>();

	constructor(initial: ProviderStatus = { state: "idle" }) {
		this.#status = initial;
	}

	get status(): ProviderStatus {
		return this.#status;
	}

	set(status: ProviderStatus): void {
		if (this.#status.state === "disposed") return;
		this.#status = status;
		for (const listener of [...this.#listeners]) listener(status);
	}

	subscribe(listener: (status: ProviderStatus) => void): Unsubscribe {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	clear(): void {
		this.#listeners.clear();
	}
}
