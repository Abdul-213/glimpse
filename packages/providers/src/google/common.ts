// Shared plumbing for the Google Cloud providers (GLIM-22): Cloud Vision (OCR, GLIM-60) and
// Cloud Translation Basic v2 (GLIM-61). One API key, restricted to both APIs, lives in the
// OS keychain under `GOOGLE_SECRET_ID` and is read through core's SecretStore port.
//
// - Requests go out with plain `fetch` from the Bun process (never the webview), the key in
//   the `x-goog-api-key` header (not `?key=`, so it never lands in a URL or a log line).
// - Every failure becomes a `ProviderError` from core's vocabulary. Google's own reason
//   (`API_KEY_INVALID`, `SERVICE_DISABLED`, `BILLING_DISABLED`, ...) is kept as a
//   `GoogleProblem` so Settings ("Test key") and the popup can say exactly what to fix.
// - Nothing here logs. Error messages carry Google's reason and HTTP status, never the key
//   (scrubbed defensively) and never request content.

import {
	isAbortError,
	isPlainObject,
	ProviderError,
	type ProviderErrorCode,
	type ProviderId,
	type SecretStore,
	SecretStoreError,
	scrubSecret,
	throwIfAborted,
} from "@glimpse/core";

/** Keychain entry shared by Vision and Translation v2 (one Google Cloud API key). */
export const GOOGLE_SECRET_ID = "google-cloud";

/** The Google APIs Glimpse calls. Used in error copy ("Enable the Cloud Vision API"). */
export type GoogleApi = "vision" | "translate";

export const GOOGLE_API_NAMES: Readonly<Record<GoogleApi, string>> = {
	vision: "Cloud Vision API",
	translate: "Cloud Translation API",
};

/** `fetch` as the providers use it; tests pass a fake that returns recorded responses. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** What the Google providers need from the app's provider context. */
export interface GoogleCloudContext {
	readonly google: {
		readonly secrets: SecretStore;
		/** Default: the global `fetch`. */
		readonly fetch?: FetchLike;
	};
}

/**
 * Why Google refused, finer than `ProviderErrorCode`, so the fix-it copy can be specific.
 * The most likely first-run failure is `api-disabled` (GLIM-22 "Errors").
 */
export type GoogleProblem =
	/** No key in the keychain. */
	| "no-key"
	/** Google says the key is not valid (typo, deleted key). */
	| "key-invalid"
	/** The key is restricted to other APIs (the user restricted it, but not to this one). */
	| "key-api-blocked"
	/** The key is restricted to websites, IPs or apps, which a desktop app can't satisfy. */
	| "key-app-blocked"
	/** The API is not enabled in the key's project. */
	| "api-disabled"
	/** Billing is not enabled for the project. */
	| "billing-disabled"
	/** Other 403s: the project or key may not use this API. */
	| "permission-denied"
	/** Per-minute rate limit: retry after a pause. */
	| "rate-limited"
	/** Daily or project quota used up. */
	| "quota-exceeded"
	| "offline"
	| "timeout"
	/** 5xx, unreadable reply. */
	| "server"
	/** The request itself was bad (a bug on our side, or an image Google can't read). */
	| "bad-request"
	/** The keychain could not be read (locked, denied, unavailable). */
	| "keychain";

const PROBLEM_CODES: Readonly<Record<GoogleProblem, ProviderErrorCode>> = {
	"no-key": "needs-key",
	"key-invalid": "invalid-key",
	"key-api-blocked": "invalid-key",
	"key-app-blocked": "invalid-key",
	"api-disabled": "invalid-key",
	"billing-disabled": "invalid-key",
	"permission-denied": "invalid-key",
	"rate-limited": "rate-limited",
	"quota-exceeded": "quota-exceeded",
	offline: "offline",
	timeout: "timeout",
	server: "network",
	"bad-request": "invalid-request",
	keychain: "needs-key",
};

export const problemCode = (problem: GoogleProblem): ProviderErrorCode => PROBLEM_CODES[problem];

/**
 * One sentence (or two) a user can act on, for Settings' "Test key" and the details of a
 * cloud error. The popup's own headings come from the snip-popup.md copy table by error code.
 */
export function googleProblemCopy(problem: GoogleProblem, api: GoogleApi): string {
	const name = GOOGLE_API_NAMES[api];
	switch (problem) {
		case "no-key":
			return "No Google Cloud API key is saved. Add one in Settings › Providers.";
		case "key-invalid":
			return "Google says this API key isn't valid. Check that you copied the whole key, or create a new one.";
		case "key-api-blocked":
			return `This key is restricted to other APIs. In the Google Cloud console, add the ${name} to the key's API restrictions.`;
		case "key-app-blocked":
			return "This key only works from certain websites, apps or IP addresses. Set its application restriction to None (keep the API restrictions).";
		case "api-disabled":
			return `The ${name} isn't enabled for this key's project. Enable it in the Google Cloud console, wait a minute, then try again.`;
		case "billing-disabled":
			return "Billing isn't enabled for this key's Google Cloud project. Google needs a billing account even for the free tier.";
		case "permission-denied":
			return `Google refused this key for the ${name}. Check the key's restrictions and the project's permissions.`;
		case "rate-limited":
			return "Too many requests in a short time. Glimpse will try again shortly.";
		case "quota-exceeded":
			return `This key's quota for the ${name} is used up. It resets on Google's schedule, or you can raise it in the Google Cloud console.`;
		case "offline":
			return "Couldn't reach Google. Check your internet connection.";
		case "timeout":
			return "Google didn't answer in time. Try again.";
		case "server":
			return "Google had a problem answering. Try again in a moment.";
		case "bad-request":
			return "Google couldn't use this request.";
		case "keychain":
			return "Glimpse couldn't read the saved API key from the system password store.";
	}
}

/** A `ProviderError` that also says which Google problem it was. */
export class GoogleError extends ProviderError {
	readonly problem: GoogleProblem;
	readonly api: GoogleApi;
	readonly httpStatus: number | null;

	constructor(
		problem: GoogleProblem,
		api: GoogleApi,
		message: string,
		options: {
			readonly providerId: ProviderId;
			readonly httpStatus?: number | null;
			readonly retryAfterMs?: number;
			readonly cause?: unknown;
		},
	) {
		super(problemCode(problem), message, {
			providerId: options.providerId,
			...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
			...(options.cause === undefined ? {} : { cause: options.cause }),
		});
		this.name = "GoogleError";
		this.problem = problem;
		this.api = api;
		this.httpStatus = options.httpStatus ?? null;
	}

	get userMessage(): string {
		return googleProblemCopy(this.problem, this.api);
	}
}

/** Google's JSON error envelope (`google.rpc.Status` plus the legacy `errors` list). */
interface GoogleErrorBody {
	readonly code?: number;
	readonly message?: string;
	readonly status?: string;
	readonly reasons: readonly string[];
	readonly retryDelayMs?: number;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Pull `status`, `message` and every `reason` out of a Google error body. Lenient. */
export function parseGoogleErrorBody(body: unknown): GoogleErrorBody {
	const error = isPlainObject(body) && isPlainObject(body["error"]) ? body["error"] : null;
	if (!error) return { reasons: [] };
	const reasons: string[] = [];
	let retryDelayMs: number | undefined;
	const details = Array.isArray(error["details"]) ? error["details"] : [];
	for (const d of details) {
		if (!isPlainObject(d)) continue;
		const reason = str(d["reason"]);
		if (reason) reasons.push(reason);
		// google.rpc.RetryInfo: { retryDelay: "3s" }
		const delay = str(d["retryDelay"]);
		const m = delay ? /^(\d+(?:\.\d+)?)s$/.exec(delay) : null;
		if (m?.[1]) retryDelayMs = Math.round(Number(m[1]) * 1000);
	}
	const legacy = Array.isArray(error["errors"]) ? error["errors"] : [];
	for (const e of legacy) {
		const reason = isPlainObject(e) ? str(e["reason"]) : undefined;
		if (reason) reasons.push(reason);
	}
	const code = typeof error["code"] === "number" ? error["code"] : undefined;
	const message = str(error["message"]);
	const status = str(error["status"]);
	return {
		reasons,
		...(code === undefined ? {} : { code }),
		...(message === undefined ? {} : { message }),
		...(status === undefined ? {} : { status }),
		...(retryDelayMs === undefined ? {} : { retryDelayMs }),
	};
}

const has = (reasons: readonly string[], ...want: string[]) => reasons.some((r) => want.includes(r));

/**
 * Map an HTTP status and Google error body to a problem. Covers the documented reasons
 * (`google.rpc.ErrorInfo.reason`) and the legacy `errors[].reason` strings v2 still sends.
 */
export function classifyGoogleError(httpStatus: number, body: GoogleErrorBody): GoogleProblem {
	const { reasons, status = "", message = "" } = body;
	if (has(reasons, "API_KEY_INVALID", "keyInvalid") || /api key not valid/i.test(message)) return "key-invalid";
	if (has(reasons, "API_KEY_SERVICE_BLOCKED")) return "key-api-blocked";
	if (
		has(
			reasons,
			"API_KEY_HTTP_REFERRER_BLOCKED",
			"API_KEY_IP_ADDRESS_BLOCKED",
			"API_KEY_ANDROID_APP_BLOCKED",
			"API_KEY_IOS_APP_BLOCKED",
		)
	) {
		return "key-app-blocked";
	}
	if (has(reasons, "SERVICE_DISABLED", "accessNotConfigured")) return "api-disabled";
	if (has(reasons, "BILLING_DISABLED") || /billing/i.test(message)) return "billing-disabled";
	if (has(reasons, "dailyLimitExceeded", "quotaExceeded", "dailyLimitExceededUnreg")) return "quota-exceeded";
	if (has(reasons, "RATE_LIMIT_EXCEEDED", "rateLimitExceeded", "userRateLimitExceeded")) {
		// Per-minute limits come back as RATE_LIMIT_EXCEEDED; per-day ones say so in the message.
		return /per day|daily/i.test(message) ? "quota-exceeded" : "rate-limited";
	}
	if (httpStatus === 429 || status === "RESOURCE_EXHAUSTED") {
		return /per day|daily|quota/i.test(message) && !/per minute/i.test(message) ? "quota-exceeded" : "rate-limited";
	}
	if (httpStatus === 401 || status === "UNAUTHENTICATED") return "key-invalid";
	if (httpStatus === 403 || status === "PERMISSION_DENIED") return "permission-denied";
	if (httpStatus === 408 || status === "DEADLINE_EXCEEDED") return "timeout";
	if (httpStatus >= 500 || status === "UNAVAILABLE" || status === "INTERNAL") return "server";
	if (httpStatus === 400 || status === "INVALID_ARGUMENT") return "bad-request";
	return "server";
}

/** Bun/undici connection failures that mean "no route to Google" rather than a bad reply. */
const OFFLINE_CODES = new Set([
	"ENOTFOUND",
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"ENETDOWN",
	"ConnectionRefused",
	"FailedToOpenSocket",
	"UnableToConnect",
]);

function isOfflineError(error: unknown): boolean {
	const code = isPlainObject(error) || error instanceof Error ? (error as { code?: unknown }).code : undefined;
	if (typeof code === "string" && OFFLINE_CODES.has(code)) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /unable to connect|getaddrinfo|ENOTFOUND|network is unreachable|connection refused/i.test(message);
}

export interface GoogleCallOptions {
	readonly providerId: ProviderId;
	readonly api: GoogleApi;
	readonly fetch: FetchLike;
	readonly key: string;
	readonly url: string;
	readonly method?: "GET" | "POST";
	/** JSON body for POST. */
	readonly body?: unknown;
	readonly signal?: AbortSignal | undefined;
	/** Per-request timeout; snip-popup.md: 10 s for cloud calls. */
	readonly timeoutMs: number;
}

/**
 * One JSON call to a Google API. Resolves with the parsed body of a 2xx reply. Rejects with
 * `ProviderError("cancelled")` when `signal` fires (promptly, even mid-flight) and with a
 * `GoogleError` for everything else.
 */
export async function callGoogle(options: GoogleCallOptions): Promise<unknown> {
	const { providerId, api, key, signal } = options;
	throwIfAborted(signal, providerId);
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, options.timeoutMs);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const fail = (problem: GoogleProblem, message: string, extra: { httpStatus?: number; retryAfterMs?: number } = {}) =>
		new GoogleError(problem, api, scrubSecret(message, key), { providerId, ...extra });
	try {
		const cancelled = new Promise<never>((_, reject) => {
			controller.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
				once: true,
			});
		});
		cancelled.catch(() => {});
		const init: RequestInit = {
			method: options.method ?? "POST",
			headers: {
				"x-goog-api-key": key,
				accept: "application/json",
				...(options.body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
			},
			signal: controller.signal,
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
		};
		let response: Response;
		try {
			response = await Promise.race([options.fetch(options.url, init), cancelled]);
		} catch (error) {
			if (signal?.aborted) throw new ProviderError("cancelled", "cancelled", { providerId, cause: signal.reason });
			if (timedOut) throw fail("timeout", `${GOOGLE_API_NAMES[api]} did not answer within ${options.timeoutMs} ms`);
			if (isAbortError(error)) throw new ProviderError("cancelled", "cancelled", { providerId });
			if (isOfflineError(error)) throw fail("offline", "could not connect to Google");
			throw fail("server", `request failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		let text: string;
		try {
			text = await Promise.race([response.text(), cancelled]);
		} catch (error) {
			if (signal?.aborted) throw new ProviderError("cancelled", "cancelled", { providerId, cause: signal.reason });
			if (timedOut) throw fail("timeout", `${GOOGLE_API_NAMES[api]} did not finish answering in time`);
			throw fail("server", `reading the reply failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		let json: unknown = null;
		try {
			json = text === "" ? null : JSON.parse(text);
		} catch {
			json = null;
		}
		if (!response.ok) {
			const parsed = parseGoogleErrorBody(json);
			const problem = classifyGoogleError(response.status, parsed);
			const retryAfter = Number(response.headers.get("retry-after"));
			const retryAfterMs =
				parsed.retryDelayMs ?? (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
			const reason = parsed.reasons[0] ?? parsed.status ?? "no reason";
			throw fail(
				problem,
				`${GOOGLE_API_NAMES[api]} HTTP ${response.status} ${reason}: ${parsed.message ?? ""}`.trim(),
				{
					httpStatus: response.status,
					...(retryAfterMs === undefined ? {} : { retryAfterMs }),
				},
			);
		}
		if (json === null) throw fail("server", `${GOOGLE_API_NAMES[api]} sent a reply that isn't JSON`);
		return json;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Read the shared key. Missing → `GoogleError("no-key")` (code `needs-key`); keychain
 * failures (locked, denied) → `GoogleError("keychain")`, also `needs-key`, with the
 * keychain's kind in the message.
 */
export async function readGoogleKey(
	secrets: SecretStore,
	api: GoogleApi,
	providerId: ProviderId,
	signal?: AbortSignal,
): Promise<string> {
	throwIfAborted(signal, providerId);
	let key: string | null;
	try {
		key = await secrets.get(GOOGLE_SECRET_ID);
	} catch (error) {
		const kind = error instanceof SecretStoreError ? error.kind : "unknown";
		throw new GoogleError("keychain", api, `keychain read failed: ${kind}`, { providerId, cause: error });
	}
	throwIfAborted(signal, providerId);
	if (key === null || key.trim() === "") {
		throw new GoogleError("no-key", api, "no Google Cloud API key saved", { providerId });
	}
	return key.trim();
}

/**
 * A pasted key, cleaned (surrounding whitespace and quotes dropped), or a problem a user can
 * fix. Google Cloud API keys are 39 characters (`AIza` + 35 of `[A-Za-z0-9_-]`); the check is
 * looser than that so a future key format still saves, and "Test key" has the last word.
 */
export function cleanGoogleKey(input: string): { readonly key: string } | { readonly problem: string } {
	const key = input.trim().replace(/^["']|["']$/g, "");
	if (key === "") return { problem: "Paste your API key first." };
	if (/\s/.test(key)) return { problem: "An API key has no spaces or line breaks. Copy only the key." };
	if (!/^[A-Za-z0-9_-]+$/.test(key) || key.length < 30 || key.length > 128) {
		return {
			problem: "That doesn't look like a Google Cloud API key. Keys start with AIza and are 39 characters long.",
		};
	}
	return { key };
}
