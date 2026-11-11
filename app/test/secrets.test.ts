// GLIM-40: the keychain SecretStore. Unit tests use a fake backend; the integration suite
// runs against the real OS store (Bun.secrets) when one is reachable. On headless Linux:
//   bash app/scripts/linux-headless-keyring.sh [--fetch] bun test app/test/secrets.test.ts
// which sets GLIM_HEADLESS_KEYRING=1 and makes the integration suite mandatory.
// Integration items use service "dev.glimpse.app.test", never the real one, and are deleted.

import { describe, expect, test } from "bun:test";
import { MAX_SECRET_BYTES, maskSecret, SecretStoreError, validateSecretId } from "@glimpse/core";
import { MemorySecretStore } from "@glimpse/core/testing";
import {
	bunSecretsBackend,
	classifySecretError,
	KeychainSecretStore,
	SECRET_SERVICE,
	type SecretBackend,
} from "../src/bun/services/secrets.ts";

class FakeBackend implements SecretBackend {
	readonly items = new Map<string, string>();
	failNext: unknown = null;
	readonly calls: string[] = [];
	#take(op: string, service: string, account: string) {
		this.calls.push(`${op} ${service}/${account}`);
		const e = this.failNext;
		this.failNext = null;
		if (e) throw e;
	}
	async get(service: string, account: string) {
		this.#take("get", service, account);
		return this.items.get(`${service}/${account}`) ?? null;
	}
	async set(service: string, account: string, value: string) {
		this.#take("set", service, account);
		if (value === "")
			this.items.delete(`${service}/${account}`); // like Bun: "" deletes
		else this.items.set(`${service}/${account}`, value);
	}
	async delete(service: string, account: string) {
		this.#take("delete", service, account);
		return this.items.delete(`${service}/${account}`);
	}
}

const bunError = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});

async function rejection(p: Promise<unknown>): Promise<SecretStoreError> {
	try {
		await p;
	} catch (e) {
		if (e instanceof SecretStoreError) return e;
		throw e;
	}
	throw new Error("expected a rejection");
}

describe("KeychainSecretStore (fake backend)", () => {
	test("one item per id under service dev.glimpse.app", async () => {
		const backend = new FakeBackend();
		const store = new KeychainSecretStore({ backend });
		await store.set("cloud:google", "AIza-test-value-1234");
		expect(await store.get("cloud:google")).toBe("AIza-test-value-1234");
		expect(await store.has("deepl")).toBe(false);
		expect(await store.delete("cloud:google")).toBe(true);
		expect(await store.delete("cloud:google")).toBe(false);
		expect(SECRET_SERVICE).toBe("dev.glimpse.app");
		expect(backend.calls[0]).toBe("set dev.glimpse.app/cloud:google");
	});

	test("rejects empty values before the OS sees them (Bun would delete the item)", async () => {
		const backend = new FakeBackend();
		const store = new KeychainSecretStore({ backend });
		await store.set("deepl", "kept-value");
		const e = await rejection(store.set("deepl", ""));
		expect(e.kind).toBe("invalid");
		expect(await store.get("deepl")).toBe("kept-value");
		expect(backend.calls.filter((c) => c.startsWith("set"))).toHaveLength(1);
	});

	test("size cap is 2560 UTF-8 bytes", async () => {
		const store = new KeychainSecretStore({ backend: new FakeBackend() });
		await store.set("a", "x".repeat(MAX_SECRET_BYTES));
		expect((await rejection(store.set("a", "x".repeat(MAX_SECRET_BYTES + 1)))).kind).toBe("too-large");
		// 3 bytes per char: 854 chars = 2562 bytes.
		expect((await rejection(store.set("a", "語".repeat(854)))).kind).toBe("too-large");
	});

	test("bad ids are rejected", async () => {
		const store = new KeychainSecretStore({ backend: new FakeBackend() });
		for (const id of ["", "Upper", "../x", "a b", "x".repeat(65)]) {
			expect((await rejection(store.get(id))).kind).toBe("invalid");
		}
		expect(() => validateSecretId("cloud:google-translate-v2")).not.toThrow();
	});

	test("OS errors are mapped and the value is scrubbed from them", async () => {
		const backend = new FakeBackend();
		const logged: unknown[] = [];
		const log = { debug: () => {}, info: () => {}, warn: (_m: string, f?: unknown) => logged.push(f) };
		const store = new KeychainSecretStore({ backend, platform: "darwin", logger: log });
		const value = "my-secret-api-key-value";
		backend.failNext = bunError(`SecItemAdd failed for ${value} (code: -25308)`);
		const e = await rejection(store.set("deepl", value));
		expect(e.kind).toBe("locked");
		expect(e.platformCode).toBe(-25308);
		expect(e.message).not.toContain(value);
		expect(String(e)).not.toContain(value);
		expect(JSON.stringify(logged)).not.toContain(value);
		expect(e.userMessage).toContain("locked");
	});

	test("status() reports availability without throwing", async () => {
		const backend = new FakeBackend();
		const store = new KeychainSecretStore({ backend, platform: "linux" });
		expect(await store.status()).toEqual({ available: true });
		backend.failNext = bunError("libsecret not available", "ERR_SECRETS_PLATFORM_ERROR");
		const s = await store.status();
		expect(s.available).toBe(false);
		if (!s.available) expect(s.kind).toBe("unavailable");
	});

	test("onValue sees values read and saved (for the log redactor)", async () => {
		const seen: string[] = [];
		const store = new KeychainSecretStore({ backend: new FakeBackend(), onValue: (v) => seen.push(v) });
		await store.set("a", "value-one");
		await store.get("a");
		expect(seen).toEqual(["value-one", "value-one"]);
	});
});

describe("classifySecretError", () => {
	const cases: [unknown, NodeJS.Platform, string][] = [
		[bunError("x", "ERR_SECRETS_USER_CANCELED"), "darwin", "canceled"],
		[bunError("x", "ERR_SECRETS_INTERACTION_NOT_ALLOWED"), "darwin", "locked"],
		[bunError("x", "ERR_SECRETS_ACCESS_DENIED"), "darwin", "denied"],
		[bunError("SecItemCopyMatching failed (code: -34018)"), "darwin", "denied"],
		[bunError("SecItemCopyMatching failed (code: -25291)"), "darwin", "unavailable"],
		[bunError("CredReadW failed (code: 1312)"), "win32", "unavailable"],
		[bunError("CredWriteW failed (code: 5)"), "win32", "denied"],
		[bunError("CredWriteW failed (code: 87)"), "win32", "invalid"],
		[bunError("libsecret not available", "ERR_SECRETS_PLATFORM_ERROR"), "linux", "unavailable"],
		[bunError("The name org.freedesktop.secrets was not provided by any .service files"), "linux", "unavailable"],
		[bunError("Collection is locked"), "linux", "locked"],
		[bunError("Prompt dismissed"), "linux", "canceled"],
		[bunError("weird"), "linux", "unknown"],
		["not an error", "linux", "unknown"],
	];
	for (const [error, platform, kind] of cases) {
		test(`${platform}: ${String((error as Error).message ?? error)} -> ${kind}`, () => {
			expect(classifySecretError(error, "get", platform).kind).toBe(kind as SecretStoreError["kind"]);
		});
	}

	test("keeps runtime and platform codes, strips the code suffix from detail", () => {
		const e = classifySecretError(bunError("SecItemAdd failed (code: -128)", "ERR_SECRETS_X"), "set", "darwin");
		expect(e.kind).toBe("canceled");
		expect(e.runtimeCode).toBe("ERR_SECRETS_X");
		expect(e.platformCode).toBe(-128);
		expect(e.detail).toBe("SecItemAdd failed");
		expect(e.toInfo()).toEqual({ kind: "canceled", op: "set", userMessage: e.userMessage });
	});
});

describe("MemorySecretStore (core fake) follows the same rules", () => {
	test("validation, failure injection, status", async () => {
		const store = new MemorySecretStore({ deepl: "k" });
		expect(await store.get("deepl")).toBe("k");
		expect((await rejection(store.set("deepl", ""))).kind).toBe("invalid");
		store.failNext = "canceled";
		expect((await rejection(store.get("deepl"))).kind).toBe("canceled");
		expect(await store.get("deepl")).toBe("k");
		store.failWith = "unavailable";
		expect((await store.status()).available).toBe(false);
	});

	test("maskSecret never shows more than the last 4 characters", () => {
		expect(maskSecret(null)).toBe("(none)");
		expect(maskSecret("short")).toBe("(5 bytes)");
		expect(maskSecret("AIzaSyDdI0hCZtE6vySjMm")).toBe("…SjMm (22 bytes)");
	});
});

// ---- integration: the real OS store ------------------------------------------------

const TEST_SERVICE = "dev.glimpse.app.test";
const real = new KeychainSecretStore({ backend: bunSecretsBackend, service: TEST_SERVICE });
const realStatus = await real.status();
const required = process.env["GLIM_HEADLESS_KEYRING"] === "1" || process.env["GLIM_REQUIRE_KEYRING"] === "1";

if (!realStatus.available) {
	if (required) {
		test("OS secret store is reachable", () => {
			throw new Error(`OS secret store not reachable: ${realStatus.kind}`);
		});
	} else {
		console.warn(
			`[SKIP] keychain integration tests: no OS secret store (${realStatus.kind}). On headless Linux run: bash app/scripts/linux-headless-keyring.sh bun test app/test/secrets.test.ts`,
		);
	}
}

describe.skipIf(!realStatus.available)(`Bun.secrets on ${process.platform}`, () => {
	test("write, read, update with non-ASCII, delete", async () => {
		const id = `it-${process.pid}`;
		try {
			await real.set(id, "first-value-1234");
			expect(await real.get(id)).toBe("first-value-1234");
			await real.set(id, "zweiter Wert — 鍵 🔑");
			expect(await real.get(id)).toBe("zweiter Wert — 鍵 🔑");
			expect(await real.delete(id)).toBe(true);
			expect(await real.get(id)).toBeNull();
			expect(await real.delete(id)).toBe(false);
		} finally {
			await real.delete(id).catch(() => {});
		}
	});

	test("the size cap round-trips; ids are independent", async () => {
		const a = `it-a-${process.pid}`;
		const b = `it-b-${process.pid}`;
		try {
			await real.set(a, "x".repeat(MAX_SECRET_BYTES));
			await real.set(b, "other");
			expect((await real.get(a))?.length).toBe(MAX_SECRET_BYTES);
			await real.delete(b);
			expect(await real.has(a)).toBe(true);
		} finally {
			await real.delete(a).catch(() => {});
			await real.delete(b).catch(() => {});
		}
	});
});
