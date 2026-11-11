// GLIM-35: redaction. Every log record and the diagnostics bundle pass through this, so a
// careless call site can't leak a key, screen text or pixels into a file the user may attach
// to a public bug report.
//
//   secrets   field names that look like credentials (apiKey, token, password, ...), known
//             secret values registered with `addSecret`, and common key shapes in strings
//             (Bearer tokens, `?key=` query params, Google `AIza...`, `sk-...`) -> [redacted]
//   content   values wrapped in `sensitive(...)`, and fields named like screen text (text,
//             sourceText, translation, clipboard, ...) -> `[text: N chars]`, unless the
//             redactor was built with `includeContent` (a developer opt-in, never a default)
//   binary    typed arrays, ArrayBuffers (captured pixels, model bytes) -> `[binary: N bytes]`,
//             always, even with includeContent
//   paths     the user's home directory -> `~` (it usually contains their name)
//
// Output is plain JSON with bounded size (depth, array length, string length).

import type { JsonLogValue, LogFields } from "./types.ts";

export const REDACTED = "[redacted]";

const SENSITIVE = Symbol("glimpse.sensitive");

/** Screen content (OCR text, translations, clipboard): logged only as its length unless content logging is on. */
export interface Sensitive {
	readonly [SENSITIVE]: true;
	readonly value: unknown;
}

export const sensitive = (value: unknown): Sensitive => ({ [SENSITIVE]: true, value });

const isSensitive = (value: unknown): value is Sensitive =>
	typeof value === "object" && value !== null && SENSITIVE in value;

export interface RedactorOptions {
	/** Log screen text verbatim. Developer opt-in (GLIMPSE_LOG_SCREEN_TEXT=1); never on by default. */
	readonly includeContent?: boolean;
	/** Replaced with `~` in every string. */
	readonly homeDir?: string;
	readonly maxStringLength?: number;
	readonly maxArrayLength?: number;
	readonly maxDepth?: number;
}

/** Words that make a field name a credential. Compared against the name's words (camel/snake/kebab split). */
const SECRET_WORDS = new Set([
	"secret",
	"secrets",
	"token",
	"tokens",
	"password",
	"passwd",
	"passphrase",
	"authorization",
	"auth",
	"credential",
	"credentials",
	"cookie",
	"apikey",
	"bearer",
	"signature",
]);

/** Words that make a field name screen content. */
const CONTENT_WORDS = new Set(["text", "texts", "translation", "translations", "original", "clipboard", "transcript"]);

/** Split `apiKey`, `api_key`, `API-KEY`, `sourceText` into lowercase words. */
export function keyWords(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((w) => w.toLowerCase());
}

export function isSecretKey(key: string): boolean {
	const words = keyWords(key);
	if (words.some((w) => SECRET_WORDS.has(w))) return true;
	// `key`, `apiKey`, `api_key`, `licenseKey`; but not `hotkey` (one word) or `cacheKeyPrefix`.
	const last = words[words.length - 1];
	return last === "key" && words.length <= 2 && words[0] !== "cache" && words[0] !== "sort";
}

export function isContentKey(key: string): boolean {
	return keyWords(key).some((w) => CONTENT_WORDS.has(w));
}

/** Shapes of real credentials, scrubbed from any string (defence in depth). */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
	[/([?&](?:key|api_key|apikey|access_token|token|auth_key|sig|signature)=)[^&#\s"']+/gi, `$1${REDACTED}`],
	[/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED], // Google API keys
	[/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED], // OpenAI-style keys
	[/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:fx\b/gi, REDACTED], // DeepL free keys
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Redactor {
	readonly includeContent: boolean;
	readonly #secrets = new Set<string>();
	readonly #home: RegExp | null;
	readonly #maxString: number;
	readonly #maxArray: number;
	readonly #maxDepth: number;

	constructor(options: RedactorOptions = {}) {
		this.includeContent = options.includeContent ?? false;
		const home = options.homeDir?.replace(/[\\/]+$/, "");
		// Only redact a home dir that is specific enough not to mangle unrelated text.
		this.#home = home && home.length >= 4 ? new RegExp(escapeRegExp(home), home.includes("\\") ? "gi" : "g") : null;
		this.#maxString = options.maxStringLength ?? 2000;
		this.#maxArray = options.maxArrayLength ?? 50;
		this.#maxDepth = options.maxDepth ?? 5;
	}

	/** Register a secret value (an API key just read or saved) so it is scrubbed wherever it appears. */
	addSecret(value: string): void {
		if (value.length >= 6) this.#secrets.add(value);
	}

	removeSecret(value: string): void {
		this.#secrets.delete(value);
	}

	/** Scrub one string: known secrets, credential shapes, home dir; then cap its length. */
	string(text: string): string {
		let out = text;
		for (const secret of this.#secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
		for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
		if (this.#home) out = out.replace(this.#home, "~");
		if (out.length > this.#maxString)
			out = `${out.slice(0, this.#maxString)}… [${out.length - this.#maxString} more chars]`;
		return out;
	}

	/** Redact a whole fields object into plain JSON. */
	fields(fields: LogFields | undefined): Record<string, JsonLogValue> {
		const out: Record<string, JsonLogValue> = {};
		if (!fields) return out;
		for (const [key, value] of Object.entries(fields)) {
			if (value === undefined) continue;
			out[key] = this.field(key, value, 0, new Set());
		}
		return out;
	}

	/** Redact any value (no key context). */
	value(value: unknown): JsonLogValue {
		return this.#value(value, 0, new Set());
	}

	field(key: string, value: unknown, depth: number, seen: Set<object>): JsonLogValue {
		if (isSecretKey(key)) return value === null || value === undefined || value === "" ? null : REDACTED;
		if (isContentKey(key) && !this.includeContent && !isSensitive(value)) return this.#contentSummary(value);
		return this.#value(value, depth, seen);
	}

	#contentSummary(value: unknown): JsonLogValue {
		if (value === null || value === undefined) return null;
		if (typeof value === "string") return `[text: ${value.length} chars]`;
		if (Array.isArray(value)) return `[text: ${value.length} items]`;
		if (typeof value === "number" || typeof value === "boolean") return value;
		if (isBinary(value)) return binarySummary(value);
		return "[text]";
	}

	#value(value: unknown, depth: number, seen: Set<object>): JsonLogValue {
		if (value === null || value === undefined) return null;
		switch (typeof value) {
			case "string":
				return this.string(value);
			case "number":
				return Number.isFinite(value) ? value : String(value);
			case "boolean":
				return value;
			case "bigint":
				return value.toString();
			case "symbol":
				return value.toString();
			case "function":
				return "[function]";
		}
		if (isSensitive(value)) {
			return this.includeContent ? this.#value(value.value, depth, seen) : this.#contentSummary(value.value);
		}
		if (isBinary(value)) return binarySummary(value);
		const obj = value as object;
		if (seen.has(obj)) return "[circular]";
		if (depth >= this.#maxDepth) return "[…]";
		seen.add(obj);
		try {
			if (obj instanceof Error) return this.#error(obj, depth, seen);
			if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
			if (obj instanceof Map) return this.#value(Object.fromEntries(obj), depth, seen);
			if (obj instanceof Set) return this.#value([...obj], depth, seen);
			if (Array.isArray(obj)) {
				const items = obj.slice(0, this.#maxArray).map((v) => this.#value(v, depth + 1, seen));
				if (obj.length > this.#maxArray) items.push(`[${obj.length - this.#maxArray} more]`);
				return items;
			}
			const out: Record<string, JsonLogValue> = {};
			for (const [k, v] of Object.entries(obj)) {
				if (v === undefined) continue;
				out[k] = this.field(k, v, depth + 1, seen);
			}
			return out;
		} finally {
			seen.delete(obj);
		}
	}

	#error(error: Error, depth: number, seen: Set<object>): JsonLogValue {
		const out: Record<string, JsonLogValue> = { name: this.string(error.name), message: this.string(error.message) };
		// Own enumerable props carry codes (`code`, `kind`, `bunCode`); they go through the same rules.
		for (const [k, v] of Object.entries(error)) {
			if (v === undefined || k === "stack" || k === "message" || k === "name") continue;
			out[k] = this.field(k, v, depth + 1, seen);
		}
		if (error.stack) out["stack"] = this.string(error.stack.split("\n").slice(0, 12).join("\n"));
		if (error.cause !== undefined) out["cause"] = this.#value(error.cause, depth + 1, seen);
		return out;
	}
}

function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
	return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

const binarySummary = (value: ArrayBuffer | ArrayBufferView): string => `[binary: ${value.byteLength} bytes]`;
