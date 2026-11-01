// One error vocabulary for every provider, so the pipeline and UI can react to a cause
// ("pack not installed", "key invalid", "offline") without knowing which engine failed.

import type { ProviderId } from "./provenance.ts";

export type ProviderErrorCode =
	/** The caller's AbortSignal fired. Never shown to the user, never cached. */
	| "cancelled"
	/** `init()` has not finished, or the provider was disposed. */
	| "not-ready"
	/** A model or language pack is not installed (GLIM-57 shows a download action). */
	| "model-missing"
	/** The provider can never serve this language or pair. */
	| "unsupported-language"
	/** The input exceeds a declared capability limit (`maxCharsPerSegment`, `maxImagePixels`...). */
	| "input-too-large"
	/** A cloud provider has no key in the keychain. */
	| "needs-key"
	/** The service rejected the key (invalid, API not enabled, billing off). */
	| "invalid-key"
	/** No network connection. */
	| "offline"
	/** Any other transport or HTTP 5xx failure. */
	| "network"
	/** HTTP 429 or equivalent; see `retryAfterMs`. */
	| "rate-limited"
	/** The account's quota or spend guard is exhausted. */
	| "quota-exceeded"
	| "timeout"
	/** The request breaks the interface contract (duplicate segment ids, bad image). A bug. */
	| "invalid-request"
	/** Anything else: an engine crash, malformed output, failed output validation. */
	| "internal";

/** Plain-data form of a provider error, for per-block results and RPC. */
export interface ProviderErrorInfo {
	readonly code: ProviderErrorCode;
	/** Developer-facing detail. Never contains keys or screen text. UI copy is chosen by `code`. */
	readonly message: string;
	readonly retryable: boolean;
	readonly providerId: ProviderId | null;
	readonly retryAfterMs?: number;
}

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(["offline", "network", "rate-limited", "timeout"]);

export const isRetryableCode = (code: ProviderErrorCode): boolean => RETRYABLE.has(code);

export interface ProviderErrorOptions {
	readonly providerId?: ProviderId | null;
	readonly retryable?: boolean;
	readonly retryAfterMs?: number;
	readonly cause?: unknown;
}

export class ProviderError extends Error {
	readonly code: ProviderErrorCode;
	readonly retryable: boolean;
	readonly providerId: ProviderId | null;
	readonly retryAfterMs: number | undefined;

	constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ProviderError";
		this.code = code;
		this.retryable = options.retryable ?? isRetryableCode(code);
		this.providerId = options.providerId ?? null;
		this.retryAfterMs = options.retryAfterMs;
	}

	toInfo(): ProviderErrorInfo {
		const info: ProviderErrorInfo = {
			code: this.code,
			message: this.message,
			retryable: this.retryable,
			providerId: this.providerId,
		};
		return this.retryAfterMs === undefined ? info : { ...info, retryAfterMs: this.retryAfterMs };
	}

	static fromInfo(info: ProviderErrorInfo): ProviderError {
		const options: ProviderErrorOptions = {
			providerId: info.providerId,
			retryable: info.retryable,
			...(info.retryAfterMs === undefined ? {} : { retryAfterMs: info.retryAfterMs }),
		};
		return new ProviderError(info.code, info.message, options);
	}

	/** Normalise anything thrown inside a provider. AbortErrors become `cancelled`. */
	static from(error: unknown, providerId: ProviderId | null = null): ProviderError {
		if (error instanceof ProviderError) return error;
		if (isAbortError(error)) return new ProviderError("cancelled", "cancelled", { providerId, cause: error });
		const message = error instanceof Error ? error.message : String(error);
		return new ProviderError("internal", message, { providerId, cause: error });
	}
}

export const isProviderError = (error: unknown, code?: ProviderErrorCode): error is ProviderError =>
	error instanceof ProviderError && (code === undefined || error.code === code);

/** True for DOM-style AbortErrors (`signal.reason` default, `fetch` aborts) and our `cancelled`. */
export function isAbortError(error: unknown): boolean {
	if (error instanceof ProviderError) return error.code === "cancelled";
	return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/** Throw `ProviderError("cancelled")` if the signal has fired. Call at every await point. */
export function throwIfAborted(signal: AbortSignal | undefined, providerId: ProviderId | null = null): void {
	if (signal?.aborted) {
		throw new ProviderError("cancelled", "cancelled", { providerId, cause: signal.reason });
	}
}

/**
 * Race a promise against a signal: rejects with `cancelled` as soon as the signal fires,
 * even if the underlying work (a WASM call, a worker round trip) can't be interrupted.
 */
export function abortable<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	providerId: ProviderId | null = null,
): Promise<T> {
	if (!signal) return promise;
	throwIfAborted(signal, providerId);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new ProviderError("cancelled", "cancelled", { providerId, cause: signal.reason }));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
