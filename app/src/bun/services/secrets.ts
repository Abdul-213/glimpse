// GLIM-40: the core SecretStore port on the OS keychain, through `Bun.secrets` (chosen in
// the GLIM-18 spike, spikes/keychain/FINDINGS.md):
//
//   macOS    Keychain Services, generic password, file-based login keychain;
//            service "dev.glimpse.app", account = secret id. Caller is the Oven-signed `bun`.
//   Windows  Credential Manager, CRED_TYPE_GENERIC, TargetName "dev.glimpse.app/<id>",
//            persist "local" (Bun's default, ENTERPRISE, would roam with the profile).
//   Linux    libsecret (dev only; headless tests via spikes/keychain/scripts/linux-headless-keyring.sh).
//
// Never `allowUnrestrictedAccess` (macOS "any app" ACL). Validation (id pattern, empty
// value, 2560-byte cap) is core's, so the memory fake and this store agree. OS errors are
// mapped to `SecretStoreError` kinds; values are scrubbed from any OS text and never logged.
//
// No electrobun imports: `Bun.secrets` is a Bun global, works in Electrobun's Worker.

import {
	type SecretErrorKind,
	type SecretOp,
	type SecretStore,
	SecretStoreError,
	type SecretStoreStatus,
	scrubSecret,
	validateSecretId,
	validateSecretValue,
} from "@glimpse/core";

export const SECRET_SERVICE = "dev.glimpse.app";

/** The slice of core's Logger port (GLIM-35) this store uses. Fields never include values. */
export interface SecretsLog {
	debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
	info(message: string, fields?: Readonly<Record<string, unknown>>): void;
	warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** The OS calls, injectable so the wrapper logic is tested without a keychain. */
export interface SecretBackend {
	get(service: string, account: string): Promise<string | null>;
	set(service: string, account: string, value: string): Promise<void>;
	delete(service: string, account: string): Promise<boolean>;
}

export const bunSecretsBackend: SecretBackend = {
	get: (service, name) => Bun.secrets.get({ service, name }),
	set: (service, name, value) => Bun.secrets.set({ service, name, value, persist: "local" }),
	delete: (service, name) => Bun.secrets.delete({ service, name }),
};

const MAC_CODES: Readonly<Record<number, SecretErrorKind>> = {
	[-25308]: "locked", // errSecInteractionNotAllowed: locked and no UI allowed (ssh, screen locked)
	[-25315]: "locked", // errSecInteractionRequired
	[-128]: "canceled", // errSecUserCanceled
	[-25293]: "denied", // errSecAuthFailed
	[-34018]: "denied", // errSecMissingEntitlement (data-protection keychain without entitlement)
	[-25291]: "unavailable", // errSecNotAvailable
	[-25294]: "unavailable", // errSecNoSuchKeychain
	[-25295]: "unavailable", // errSecInvalidKeychain
};

const WIN_CODES: Readonly<Record<number, SecretErrorKind>> = {
	1312: "unavailable", // ERROR_NO_SUCH_LOGON_SESSION: service / network / ssh logon without a profile
	5: "denied", // ERROR_ACCESS_DENIED
	87: "invalid", // ERROR_INVALID_PARAMETER (expected for an oversized blob; we pre-check the size)
};

const RUNTIME_CODES: Readonly<Record<string, SecretErrorKind>> = {
	ERR_SECRETS_INTERACTION_NOT_ALLOWED: "locked",
	ERR_SECRETS_INTERACTION_REQUIRED: "locked",
	ERR_SECRETS_USER_CANCELED: "canceled",
	ERR_SECRETS_AUTH_FAILED: "denied",
	ERR_SECRETS_ACCESS_DENIED: "denied",
	ERR_INVALID_ARG_VALUE: "invalid",
	ERR_INVALID_ARG_TYPE: "invalid",
};

const TEXT_PATTERNS: readonly [RegExp, SecretErrorKind][] = [
	[/libsecret not available/i, "unavailable"],
	[/not provided by any \.service files|ServiceUnknown|Cannot autolaunch D-Bus|No such interface|dbus/i, "unavailable"],
	[/locked/i, "locked"],
	[/dismissed|cancel/i, "canceled"],
	[/denied|not authorized/i, "denied"],
];

/** Map anything `Bun.secrets` throws to a SecretStoreError. `secret` is scrubbed from the text. */
export function classifySecretError(
	error: unknown,
	op: SecretOp,
	platform: NodeJS.Platform,
	secret?: string,
): SecretStoreError {
	if (error instanceof SecretStoreError) return error;
	const e = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; message?: unknown };
	const runtimeCode = typeof e.code === "string" ? e.code : undefined;
	const message = scrubSecret(typeof e.message === "string" ? e.message : String(error), secret);
	const match = /\(code: (-?\d+)\)\s*$/.exec(message);
	const platformCode = match ? Number(match[1]) : undefined;

	let kind: SecretErrorKind | undefined = runtimeCode ? RUNTIME_CODES[runtimeCode] : undefined;
	if (!kind && platformCode !== undefined) {
		const table = platform === "darwin" ? MAC_CODES : platform === "win32" ? WIN_CODES : {};
		kind = table[platformCode];
	}
	if (!kind) kind = TEXT_PATTERNS.find(([re]) => re.test(message))?.[1];
	const detail = message.replace(/\s*\(code: -?\d+\)\s*$/, "");
	return new SecretStoreError(kind ?? "unknown", op, detail, { runtimeCode, platformCode });
}

export interface KeychainSecretStoreOptions {
	readonly backend?: SecretBackend;
	readonly service?: string;
	readonly platform?: NodeJS.Platform;
	readonly logger?: SecretsLog;
	/**
	 * Called with every value read or saved, so the composition root can register it with the
	 * log redactor (GLIM-35) and it is scrubbed wherever it might appear later.
	 */
	readonly onValue?: (value: string) => void;
}

/** Account used by `status()`. Never written, so reading it can't prompt. */
const PROBE_ACCOUNT = "availability-probe";

export class KeychainSecretStore implements SecretStore {
	readonly service: string;
	readonly #backend: SecretBackend;
	readonly #platform: NodeJS.Platform;
	readonly #log: SecretsLog | undefined;
	readonly #onValue: ((value: string) => void) | undefined;

	constructor(options: KeychainSecretStoreOptions = {}) {
		this.service = options.service ?? SECRET_SERVICE;
		this.#backend = options.backend ?? bunSecretsBackend;
		this.#platform = options.platform ?? process.platform;
		this.#log = options.logger;
		this.#onValue = options.onValue;
	}

	async get(id: string): Promise<string | null> {
		validateSecretId(id);
		try {
			const value = await this.#backend.get(this.service, id);
			if (value) this.#onValue?.(value);
			this.#log?.debug("read", { id, found: value !== null });
			return value;
		} catch (error) {
			throw this.#fail(error, "get", id);
		}
	}

	async has(id: string): Promise<boolean> {
		return (await this.get(id)) !== null;
	}

	async set(id: string, value: string): Promise<void> {
		validateSecretId(id);
		validateSecretValue(value);
		this.#onValue?.(value);
		try {
			await this.#backend.set(this.service, id, value);
			this.#log?.info("saved", { id });
		} catch (error) {
			throw this.#fail(error, "set", id, value);
		}
	}

	async delete(id: string): Promise<boolean> {
		validateSecretId(id);
		try {
			const deleted = await this.#backend.delete(this.service, id);
			this.#log?.info("deleted", { id, deleted });
			return deleted;
		} catch (error) {
			throw this.#fail(error, "delete", id);
		}
	}

	async status(): Promise<SecretStoreStatus> {
		try {
			await this.#backend.get(this.service, PROBE_ACCOUNT);
			return { available: true };
		} catch (error) {
			const e = this.#fail(error, "get", PROBE_ACCOUNT);
			return { available: false, kind: e.kind, userMessage: e.userMessage };
		}
	}

	#fail(error: unknown, op: SecretOp, id: string, value?: string): SecretStoreError {
		const e = classifySecretError(error, op, this.#platform, value);
		// The error carries kind, codes and scrubbed OS text; never the value.
		this.#log?.warn("keychain error", {
			id,
			op,
			kind: e.kind,
			runtimeCode: e.runtimeCode,
			platformCode: e.platformCode,
			detail: e.detail,
		});
		return e;
	}
}
