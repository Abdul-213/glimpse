// An in-memory SecretStore for tests. Enforces the port's rules (ids, empty values, size
// cap) like the keychain store does, and can be told to fail or be unavailable.

import {
	type SecretErrorKind,
	type SecretOp,
	type SecretStore,
	SecretStoreError,
	type SecretStoreStatus,
	secretUserMessage,
	validateSecretId,
	validateSecretValue,
} from "../secrets/store.ts";

export class MemorySecretStore implements SecretStore {
	readonly items = new Map<string, string>();
	/** Every call fails with this kind (e.g. `unavailable`, `locked`) until cleared. */
	failWith: SecretErrorKind | null = null;
	/** Only the next call fails with this kind. */
	failNext: SecretErrorKind | null = null;
	readonly calls: { op: SecretOp; id: string }[] = [];

	constructor(initial: Readonly<Record<string, string>> = {}) {
		for (const [id, value] of Object.entries(initial)) this.items.set(id, value);
	}

	async get(id: string): Promise<string | null> {
		this.#enter("get", id);
		return this.items.get(id) ?? null;
	}

	async has(id: string): Promise<boolean> {
		return (await this.get(id)) !== null;
	}

	async set(id: string, value: string): Promise<void> {
		validateSecretId(id);
		validateSecretValue(value);
		this.#enter("set", id);
		this.items.set(id, value);
	}

	async delete(id: string): Promise<boolean> {
		this.#enter("delete", id);
		return this.items.delete(id);
	}

	async status(): Promise<SecretStoreStatus> {
		const kind = this.failWith;
		return kind ? { available: false, kind, userMessage: secretUserMessage(kind) } : { available: true };
	}

	#enter(op: SecretOp, id: string): void {
		validateSecretId(id);
		this.calls.push({ op, id });
		const kind = this.failNext ?? this.failWith;
		this.failNext = null;
		if (kind) throw new SecretStoreError(kind, op, `memory store set to fail (${kind})`);
	}
}
