// GLIM-40: the SecretStore port. Cloud providers read their API key through it (the id is
// the provider's `capabilities.secretId`, e.g. one Google key shared by Vision and
// Translation v2). The app implements it on the OS keychain with `Bun.secrets`
// (app/src/bun/services/secrets.ts, from spikes/keychain); tests use `MemorySecretStore`
// from @glimpse/core/testing, which enforces the same rules.
//
// Rules every implementation follows (PRODUCT.md: keys only in the OS keychain):
// - One item per secret id. Ids match `SECRET_ID_PATTERN`.
// - Empty values are rejected: `Bun.secrets.set` with "" silently deletes the item, so a
//   cleared text field must never reach it. Deleting is an explicit `delete`.
// - Values are capped at `MAX_SECRET_BYTES` UTF-8 bytes on every OS (Windows' credential
//   blob limit), so a key that fits on one OS fits on the other.
// - Values never appear in errors, logs or `toString`. Errors carry a kind, the operation,
//   the OS code and scrubbed OS text.
// - No keychain means no cloud keys: an unavailable store is reported, never replaced by a
//   plaintext fallback.

export const SECRET_ID_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

/** Windows `CRED_MAX_CREDENTIAL_BLOB_SIZE` (5 x 512). Real API keys are 30–200 bytes. */
export const MAX_SECRET_BYTES = 2560;

export type SecretErrorKind =
	/** Keychain or collection locked, and the OS could not (or may not) ask to unlock. */
	| "locked"
	/** The user dismissed an OS prompt. */
	| "canceled"
	/** The OS refused access (ACL, wrong keychain password, missing entitlement). */
	| "denied"
	/** No secret store at all (no libsecret, no logon session). */
	| "unavailable"
	| "too-large"
	/** Bad id or value, caught before the OS call. */
	| "invalid"
	| "unknown";

export type SecretOp = "get" | "set" | "delete" | "validate";

const USER_MESSAGES: Readonly<Record<SecretErrorKind, string>> = {
	locked: "Your keychain is locked. Unlock it and try again.",
	canceled: "Keychain access was cancelled, so the API key was not used.",
	denied: "The system denied Glimpse access to the saved API key.",
	unavailable: "No system password store is available, so API keys can't be saved.",
	"too-large": `API keys longer than ${MAX_SECRET_BYTES} bytes can't be saved.`,
	invalid: "That API key can't be saved.",
	unknown: "The system password store returned an unexpected error.",
};

/** Plain-data form for RPC and diagnostics. */
export interface SecretErrorInfo {
	readonly kind: SecretErrorKind;
	readonly op: SecretOp;
	readonly userMessage: string;
}

export class SecretStoreError extends Error {
	override readonly name = "SecretStoreError";
	readonly kind: SecretErrorKind;
	readonly op: SecretOp;
	/** Runtime error code, e.g. `ERR_SECRETS_INTERACTION_NOT_ALLOWED`. */
	readonly runtimeCode: string | undefined;
	/** OSStatus on macOS, Win32 error on Windows, GError code on Linux. */
	readonly platformCode: number | undefined;
	/** OS text, already scrubbed of the value. For logs, not for the UI. */
	readonly detail: string;

	constructor(
		kind: SecretErrorKind,
		op: SecretOp,
		detail: string,
		codes: { readonly runtimeCode?: string | undefined; readonly platformCode?: number | undefined } = {},
	) {
		const { runtimeCode, platformCode } = codes;
		super(
			`${op}: ${kind}${runtimeCode ? ` [${runtimeCode}]` : ""}${platformCode !== undefined ? ` (code ${platformCode})` : ""}: ${detail}`,
		);
		this.kind = kind;
		this.op = op;
		this.runtimeCode = runtimeCode;
		this.platformCode = platformCode;
		this.detail = detail;
	}

	get userMessage(): string {
		return USER_MESSAGES[this.kind];
	}

	toInfo(): SecretErrorInfo {
		return { kind: this.kind, op: this.op, userMessage: this.userMessage };
	}
}

export const secretUserMessage = (kind: SecretErrorKind): string => USER_MESSAGES[kind];

export function validateSecretId(id: string): void {
	if (typeof id !== "string" || !SECRET_ID_PATTERN.test(id)) {
		throw new SecretStoreError("invalid", "validate", `bad secret id ${JSON.stringify(String(id).slice(0, 80))}`);
	}
}

export function validateSecretValue(value: string): void {
	if (typeof value !== "string" || value.length === 0) {
		throw new SecretStoreError("invalid", "validate", "empty value (the keychain would treat it as delete)");
	}
	if (value.includes("\u0000")) throw new SecretStoreError("invalid", "validate", "value contains a NUL character");
	const bytes = new TextEncoder().encode(value).length;
	if (bytes > MAX_SECRET_BYTES) {
		throw new SecretStoreError("too-large", "validate", `value is ${bytes} bytes, limit ${MAX_SECRET_BYTES}`);
	}
}

/** Remove every occurrence of `secret` from `text` (defence in depth; OS messages don't echo values). */
export function scrubSecret(text: string, secret: string | undefined): string {
	if (!secret || secret.length < 4) return text;
	return text.split(secret).join("[redacted]");
}

/** What the UI may show about a saved key: never the value, at most the last 4 characters of a long one. */
export function maskSecret(secret: string | null | undefined): string {
	if (secret === null || secret === undefined) return "(none)";
	const bytes = new TextEncoder().encode(secret).length;
	return secret.length >= 16 ? `…${secret.slice(-4)} (${bytes} bytes)` : `(${bytes} bytes)`;
}

export type SecretStoreStatus =
	| { readonly available: true }
	| { readonly available: false; readonly kind: SecretErrorKind; readonly userMessage: string };

export interface SecretStore {
	/** The value, or null when nothing is saved. Throws `SecretStoreError`. */
	get(id: string): Promise<string | null>;
	has(id: string): Promise<boolean>;
	/** Save or replace. Rejects empty and oversized values. */
	set(id: string, value: string): Promise<void>;
	/** True if something was deleted. */
	delete(id: string): Promise<boolean>;
	/** Whether the OS store can be used at all (a read of an item that doesn't exist; never prompts). */
	status(): Promise<SecretStoreStatus>;
}
