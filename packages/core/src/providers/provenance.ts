// Who produced a result, and the identity the translation cache keys on (GLIM-20).
//
// Every OCR and translation result carries a `Provenance`. The UI uses it for the
// cloud-in-use indicator ("Translated by Google Cloud Translation", GLIM-22) and the
// cache uses its fingerprint fields, so a cloud result can never be served as a local
// one and a model update invalidates exactly the entries it produced.

/** Where the work ran. `cloud` means content left the device. */
export type ProviderKind = "local" | "cloud";

/** The two roles a provider can fill. */
export type ProviderTask = "ocr" | "translation";

/**
 * A provider id: lowercase, digits and `-`, with an optional `vendor:` style prefix
 * (`paddleocr`, `bergamot`, `small100`, `cloud:google-translate-v2`). Stable forever:
 * it is stored in settings and is part of cache keys.
 */
export type ProviderId = string;

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?$/;

export const isProviderId = (value: unknown): value is ProviderId =>
	typeof value === "string" && value.length <= 64 && PROVIDER_ID.test(value);

export interface ProviderRef {
	readonly id: ProviderId;
	readonly kind: ProviderKind;
	/** Product name for the indicator, e.g. "Google Cloud Translation", "On-device translation". */
	readonly name: string;
}

/** Static facts about a provider: what it is, independent of any instance. */
export interface ProviderInfo extends ProviderRef {
	readonly task: ProviderTask;
	/** Company for the tray ("Cloud: Google"); null for Glimpse's own local engines. */
	readonly vendor: string | null;
}

/**
 * The part of a cache key that identifies the producer (GLIM-20 "provider fingerprint").
 * - `modelRevision`: hash of the model files plus runtime version for local engines; the
 *   API's reported model (or a date bucket) for cloud ones. Opaque, compare for equality.
 * - `optionsHash`: stable hash of every option that changes output (formality, beam size,
 *   prompt template version...). Use `stableHash(options)`.
 */
export interface ProviderFingerprint {
	readonly providerId: ProviderId;
	readonly modelRevision: string;
	readonly optionsHash: string;
}

/** Attached to every result. Plain data: safe to send over RPC and to cache. */
export interface Provenance extends ProviderRef, ProviderFingerprint {
	/**
	 * Set by the cache, never by providers: the result was served from memory.
	 * A cloud result keeps its cloud badge and adds "(remembered)" (GLIM-22).
	 */
	readonly remembered?: true;
}

export function provenanceOf(info: ProviderRef, fingerprint: ProviderFingerprint): Provenance {
	if (fingerprint.providerId !== info.id) {
		throw new Error(`fingerprint is for ${fingerprint.providerId}, not ${info.id}`);
	}
	return {
		id: info.id,
		kind: info.kind,
		name: info.name,
		providerId: fingerprint.providerId,
		modelRevision: fingerprint.modelRevision,
		optionsHash: fingerprint.optionsHash,
	};
}

/** One string for a fingerprint, for use inside cache keys and logs. */
export const fingerprintKey = (f: ProviderFingerprint): string => `${f.providerId}|${f.modelRevision}|${f.optionsHash}`;

export const sameFingerprint = (a: ProviderFingerprint, b: ProviderFingerprint): boolean =>
	fingerprintKey(a) === fingerprintKey(b);

/**
 * JSON with object keys sorted at every level, so equal values give equal strings
 * whatever order their keys were written in. `undefined` members are dropped (as JSON
 * does); non-finite numbers become null.
 */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		if (typeof value === "number" && !Number.isFinite(value)) return "null";
		if (value === undefined || typeof value === "function" || typeof value === "symbol") return "null";
		if (typeof value === "bigint") return JSON.stringify(value.toString());
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined && typeof v !== "function" && typeof v !== "symbol")
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Small, fast, deterministic 53-bit string hash (cyrb53) as 14 hex chars. Not
 * cryptographic: for options hashes and in-memory keys only. GLIM-20 asks for an HMAC
 * for anything on disk.
 */
export function hashString(input: string, seed = 0): string {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < input.length; i++) {
		const ch = input.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
	return n.toString(16).padStart(14, "0");
}

/** `hashString(stableStringify(value))`: the standard way to build `optionsHash`. */
export const stableHash = (value: unknown): string => hashString(stableStringify(value));
