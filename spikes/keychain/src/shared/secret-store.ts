// GLIM-18 spike: a thin, Glimpse-shaped wrapper over the OS secret store.
//
// Backend: Bun.secrets (built into Bun >= 1.2.21). It calls
//   macOS   Keychain Services  SecItemAdd / SecItemCopyMatching / SecItemUpdate / SecItemDelete
//           (kSecClassGenericPassword, service + account, file-based login keychain)
//   Windows Credential Manager CredWriteW / CredReadW / CredDeleteW (CRED_TYPE_GENERIC,
//           TargetName "<service>/<account>")
//   Linux   libsecret          secret_password_store_sync / _lookup_sync / _clear_sync
//           (schema "com.oven-sh.bun.Secret", attributes service + account)
// all from Bun's own native code, on Bun's thread pool. No native code in this repo.
//
// Rules this wrapper enforces (Glimpse requirements, not Bun's):
//   - one item per cloud provider: service "dev.glimpse.app", account = provider id
//   - the secret value never appears in logs, errors, or toString output
//   - empty values are rejected (Bun.secrets.set with "" silently DELETES the item)
//   - values over the smallest platform limit are rejected before the OS sees them
//   - OS errors are mapped to a small set of kinds with user-facing messages

export const SERVICE = "dev.glimpse.app";

/** Windows CRED_MAX_CREDENTIAL_BLOB_SIZE is 5 * 512 bytes. Bun writes the UTF-8 bytes. */
export const WINDOWS_MAX_BLOB_BYTES = 5 * 512;
/** App-level cap everywhere, so a key saved on macOS would also fit on Windows. */
export const MAX_SECRET_BYTES = WINDOWS_MAX_BLOB_BYTES;

const ACCOUNT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type Platform = "darwin" | "win32" | "linux" | (string & {});

export interface SecretBackend {
	readonly name: string;
	get(service: string, account: string): Promise<string | null>;
	set(service: string, account: string, value: string): Promise<void>;
	delete(service: string, account: string): Promise<boolean>;
}

/** The real backend. `persist: "local"` keeps Windows credentials off roaming profiles. */
export const bunSecretsBackend: SecretBackend = {
	name: "Bun.secrets",
	get: (service, name) => Bun.secrets.get({ service, name }),
	set: (service, name, value) => Bun.secrets.set({ service, name, value, persist: "local" }),
	delete: (service, name) => Bun.secrets.delete({ service, name }),
};

/** In-memory backend for unit tests of the wrapper logic. */
export class MemoryBackend implements SecretBackend {
	readonly name = "memory";
	readonly items = new Map<string, string>();
	failNext: Error | null = null;
	private take() {
		const e = this.failNext;
		this.failNext = null;
		if (e) throw e;
	}
	async get(service: string, account: string) {
		this.take();
		return this.items.get(`${service}\u0000${account}`) ?? null;
	}
	async set(service: string, account: string, value: string) {
		this.take();
		if (value === "") {
			this.items.delete(`${service}\u0000${account}`); // mimic Bun: "" deletes
			return;
		}
		this.items.set(`${service}\u0000${account}`, value);
	}
	async delete(service: string, account: string) {
		this.take();
		return this.items.delete(`${service}\u0000${account}`);
	}
}

// ---- errors -------------------------------------------------------------------

export type SecretErrorKind =
	| "locked" // keychain / collection locked and the OS could not (or may not) ask to unlock
	| "canceled" // the user dismissed an OS prompt
	| "denied" // the OS refused access (ACL, wrong password, missing entitlement)
	| "unavailable" // no secret store at all (no libsecret / no daemon / no logon session)
	| "too-large"
	| "invalid" // bad account name or value, caught before the OS call
	| "unknown";

const USER_MESSAGES: Record<SecretErrorKind, string> = {
	locked: "Your keychain is locked. Unlock it and try again.",
	canceled: "Keychain access was cancelled, so the API key was not used.",
	denied: "The system denied Glimpse access to the saved API key.",
	unavailable: "No system password store is available, so API keys cannot be saved.",
	"too-large": `API keys longer than ${MAX_SECRET_BYTES} bytes cannot be saved.`,
	invalid: "That API key cannot be saved.",
	unknown: "The system password store returned an unexpected error.",
};

export class SecretStoreError extends Error {
	override readonly name = "SecretStoreError";
	constructor(
		readonly kind: SecretErrorKind,
		readonly op: "get" | "set" | "delete" | "validate",
		/** Bun error code, e.g. ERR_SECRETS_INTERACTION_NOT_ALLOWED */
		readonly bunCode: string | undefined,
		/** OSStatus on macOS, Win32 error on Windows, GError code on Linux */
		readonly platformCode: number | undefined,
		/** OS text, already scrubbed of the secret. For logs, not for the UI. */
		readonly detail: string,
	) {
		super(`${op}: ${kind}${bunCode ? ` [${bunCode}]` : ""}${platformCode !== undefined ? ` (code ${platformCode})` : ""}: ${detail}`);
	}
	get userMessage(): string {
		return USER_MESSAGES[this.kind];
	}
}

/** Remove every occurrence of `secret` from `text` (defence in depth; Bun never echoes values). */
export function scrub(text: string, secret: string | undefined): string {
	if (!secret || secret.length < 4) return text;
	return text.split(secret).join("[REDACTED]");
}

const MAC_CODES: Record<number, SecretErrorKind> = {
	[-25308]: "locked", // errSecInteractionNotAllowed: locked and no UI allowed (ssh, launchd, screen locked)
	[-25315]: "locked", // errSecInteractionRequired
	[-128]: "canceled", // errSecUserCanceled
	[-25293]: "denied", // errSecAuthFailed: wrong keychain password / denied
	[-34018]: "denied", // errSecMissingEntitlement: data-protection keychain without entitlement
	[-25291]: "unavailable", // errSecNotAvailable: no keychain available
	[-25294]: "unavailable", // errSecNoSuchKeychain
	[-25295]: "unavailable", // errSecInvalidKeychain
};

const WIN_CODES: Record<number, SecretErrorKind> = {
	1312: "unavailable", // ERROR_NO_SUCH_LOGON_SESSION: service / network / ssh logon without a profile
	5: "denied", // ERROR_ACCESS_DENIED
	87: "invalid", // ERROR_INVALID_PARAMETER (expected for an oversized blob; `cli size-probe` records the real code)
};

const LINUX_PATTERNS: [RegExp, SecretErrorKind][] = [
	[/libsecret not available/i, "unavailable"],
	[/not provided by any \.service files|ServiceUnknown|Cannot autolaunch D-Bus|No such interface|dbus/i, "unavailable"],
	[/locked/i, "locked"],
	[/dismissed|cancel/i, "canceled"],
	[/denied|not authorized/i, "denied"],
];

/** Map anything thrown by Bun.secrets to a SecretStoreError. */
export function classifyError(
	err: unknown,
	op: SecretStoreError["op"],
	platform: Platform,
	secret?: string,
): SecretStoreError {
	if (err instanceof SecretStoreError) return err;
	const e = err as { code?: unknown; message?: unknown } | null;
	const bunCode = typeof e?.code === "string" ? e.code : undefined;
	const rawMessage = typeof e?.message === "string" ? e.message : String(err);
	const message = scrub(rawMessage, secret);
	const m = /\(code: (-?\d+)\)\s*$/.exec(message);
	const platformCode = m ? Number(m[1]) : undefined;

	let kind: SecretErrorKind = "unknown";
	switch (bunCode) {
		case "ERR_SECRETS_INTERACTION_NOT_ALLOWED":
		case "ERR_SECRETS_INTERACTION_REQUIRED":
			kind = "locked";
			break;
		case "ERR_SECRETS_USER_CANCELED":
			kind = "canceled";
			break;
		case "ERR_SECRETS_AUTH_FAILED":
		case "ERR_SECRETS_ACCESS_DENIED":
			kind = "denied";
			break;
		case "ERR_INVALID_ARG_VALUE":
		case "ERR_INVALID_ARG_TYPE":
			kind = "invalid";
			break;
	}
	if (kind === "unknown" && platformCode !== undefined) {
		const table = platform === "darwin" ? MAC_CODES : platform === "win32" ? WIN_CODES : {};
		kind = table[platformCode] ?? "unknown";
	}
	if (kind === "unknown") {
		for (const [re, k] of LINUX_PATTERNS) {
			if (re.test(message)) {
				kind = k;
				break;
			}
		}
	}
	return new SecretStoreError(kind, op, bunCode, platformCode, message.replace(/\s*\(code: -?\d+\)\s*$/, ""));
}

// ---- display helpers ----------------------------------------------------------

/** What the UI / logs may show about a key: never the value, at most the last 4 chars. */
export function mask(secret: string | null | undefined): string {
	if (secret == null) return "(none)";
	const n = new TextEncoder().encode(secret).length;
	return secret.length >= 16 ? `…${secret.slice(-4)} (${n} bytes)` : `(${n} bytes)`;
}

/** Short SHA-256 prefix. Only ever used for spike *test markers*, never real keys. */
export function fingerprint(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 12);
}

// ---- the store ------------------------------------------------------------------

export interface MigrationResult {
	account: string;
	outcome: "moved" | "already-migrated" | "conflict-kept-new" | "nothing-to-migrate" | "failed";
	detail?: string;
}

export class ApiKeyStore {
	constructor(
		readonly backend: SecretBackend = bunSecretsBackend,
		readonly service: string = SERVICE,
		readonly platform: Platform = process.platform,
	) {}

	static validateAccount(account: string): void {
		if (!ACCOUNT_RE.test(account)) {
			throw new SecretStoreError("invalid", "validate", undefined, undefined, `bad account name ${JSON.stringify(account)}`);
		}
	}

	static validateValue(value: string): void {
		if (typeof value !== "string" || value.length === 0) {
			throw new SecretStoreError("invalid", "validate", undefined, undefined, "empty value (Bun would treat it as delete)");
		}
		if (value.includes("\u0000")) {
			throw new SecretStoreError("invalid", "validate", undefined, undefined, "value contains a NUL byte");
		}
		const bytes = new TextEncoder().encode(value).length;
		if (bytes > MAX_SECRET_BYTES) {
			throw new SecretStoreError("too-large", "validate", undefined, undefined, `value is ${bytes} bytes, limit ${MAX_SECRET_BYTES}`);
		}
	}

	async get(account: string): Promise<string | null> {
		ApiKeyStore.validateAccount(account);
		try {
			return await this.backend.get(this.service, account);
		} catch (err) {
			throw classifyError(err, "get", this.platform);
		}
	}

	async has(account: string): Promise<boolean> {
		return (await this.get(account)) !== null;
	}

	async set(account: string, value: string): Promise<void> {
		ApiKeyStore.validateAccount(account);
		ApiKeyStore.validateValue(value);
		try {
			await this.backend.set(this.service, account, value);
		} catch (err) {
			throw classifyError(err, "set", this.platform, value);
		}
	}

	async delete(account: string): Promise<boolean> {
		ApiKeyStore.validateAccount(account);
		try {
			return await this.backend.delete(this.service, account);
		} catch (err) {
			throw classifyError(err, "delete", this.platform);
		}
	}

	/**
	 * Move keys from an old service name to this store's service name.
	 * Copy, read back and compare, then delete the old item. Safe to re-run:
	 * if the new item exists it wins and the old one is left alone unless identical.
	 */
	async migrateFrom(oldService: string, accounts: readonly string[]): Promise<MigrationResult[]> {
		const old = new ApiKeyStore(this.backend, oldService, this.platform);
		const results: MigrationResult[] = [];
		for (const account of accounts) {
			try {
				const oldValue = await old.get(account);
				const newValue = await this.get(account);
				if (oldValue === null) {
					results.push({ account, outcome: newValue === null ? "nothing-to-migrate" : "already-migrated" });
					continue;
				}
				if (newValue !== null) {
					if (newValue === oldValue) {
						await old.delete(account);
						results.push({ account, outcome: "already-migrated", detail: "old copy removed" });
					} else {
						results.push({ account, outcome: "conflict-kept-new", detail: "old item left in place" });
					}
					continue;
				}
				await this.set(account, oldValue);
				const check = await this.get(account);
				if (check !== oldValue) {
					results.push({ account, outcome: "failed", detail: "read-back mismatch; old item kept" });
					continue;
				}
				await old.delete(account);
				results.push({ account, outcome: "moved" });
			} catch (err) {
				const e = err instanceof SecretStoreError ? err : classifyError(err, "get", this.platform);
				results.push({ account, outcome: "failed", detail: `${e.kind}: ${e.detail}` });
			}
		}
		return results;
	}
}
