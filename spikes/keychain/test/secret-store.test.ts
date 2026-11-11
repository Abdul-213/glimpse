// Pure-logic tests of the wrapper, against an in-memory backend. Run anywhere.
import { describe, expect, test } from "bun:test";
import { formatSteps, migrationProbe, runRoundTrip } from "../src/shared/roundtrip";
import {
	ApiKeyStore,
	MAX_SECRET_BYTES,
	MemoryBackend,
	SERVICE,
	SecretStoreError,
	classifyError,
	mask,
	scrub,
} from "../src/shared/secret-store";

function bunError(code: string, message: string) {
	return Object.assign(new Error(message), { code });
}

describe("round trip logic (memory backend)", () => {
	test("all steps pass and no value leaks into the step log", async () => {
		const backend = new MemoryBackend();
		const steps = await runRoundTrip(new ApiKeyStore(backend));
		expect(steps.filter((s) => !s.ok)).toEqual([]);
		expect(steps.length).toBe(9);
		expect(formatSteps(steps)).not.toContain("glim-test-");
		expect(backend.items.size).toBe(0);
	});

	test("migration probe passes", async () => {
		const steps = await migrationProbe(new ApiKeyStore(new MemoryBackend()));
		expect(steps.filter((s) => !s.ok)).toEqual([]);
	});
});

describe("validation", () => {
	const store = new ApiKeyStore(new MemoryBackend());

	test("empty value is rejected instead of silently deleting", async () => {
		await store.set("openai", "sk-abc");
		await expect(store.set("openai", "")).rejects.toMatchObject({ kind: "invalid" });
		expect(await store.get("openai")).toBe("sk-abc");
	});

	test("size cap is the Windows blob limit, in UTF-8 bytes", async () => {
		await store.set("big", "x".repeat(MAX_SECRET_BYTES));
		await expect(store.set("big", "x".repeat(MAX_SECRET_BYTES + 1))).rejects.toMatchObject({ kind: "too-large" });
		// 2-byte chars: half as many fit
		await expect(store.set("big", "é".repeat(MAX_SECRET_BYTES / 2 + 1))).rejects.toMatchObject({ kind: "too-large" });
	});

	test("NUL bytes and bad account names are rejected", async () => {
		await expect(store.set("openai", "a\u0000b")).rejects.toMatchObject({ kind: "invalid" });
		await expect(store.get("Open AI")).rejects.toMatchObject({ kind: "invalid" });
		await expect(store.get("")).rejects.toMatchObject({ kind: "invalid" });
	});

	test("default service name", () => {
		expect(store.service).toBe(SERVICE);
		expect(SERVICE).toBe("dev.glimpse.app");
	});
});

describe("error classification", () => {
	test("macOS locked keychain without UI", () => {
		const e = classifyError(
			bunError("ERR_SECRETS_INTERACTION_NOT_ALLOWED", "User interaction is not allowed. (code: -25308)"),
			"get",
			"darwin",
		);
		expect(e.kind).toBe("locked");
		expect(e.platformCode).toBe(-25308);
		expect(e.userMessage).toContain("locked");
	});

	test("macOS user cancelled the prompt", () => {
		expect(classifyError(bunError("ERR_SECRETS_USER_CANCELED", "User canceled the operation. (code: -128)"), "get", "darwin").kind).toBe("canceled");
	});

	test("macOS missing entitlement (data-protection keychain) maps by OSStatus", () => {
		const e = classifyError(bunError("ERR_SECRETS_PLATFORM_ERROR", "A required entitlement isn't present. (code: -34018)"), "set", "darwin");
		expect(e.kind).toBe("denied");
	});

	test("Windows no logon session (ssh / service)", () => {
		const e = classifyError(bunError("ERR_SECRETS_PLATFORM_ERROR", "A specified logon session does not exist. (code: 1312)"), "set", "win32");
		expect(e.kind).toBe("unavailable");
		expect(e.platformCode).toBe(1312);
	});

	test("Linux without libsecret / daemon", () => {
		expect(classifyError(bunError("ERR_SECRETS_PLATFORM_ERROR", "libsecret not available"), "get", "linux").kind).toBe("unavailable");
		expect(
			classifyError(bunError("ERR_SECRETS_PLATFORM_ERROR", "The name org.freedesktop.secrets was not provided by any .service files (code: 2)"), "get", "linux").kind,
		).toBe("unavailable");
		expect(classifyError(bunError("ERR_SECRETS_PLATFORM_ERROR", "Cannot create an item in a locked collection (code: 0)"), "set", "linux").kind).toBe(
			"locked",
		);
	});

	test("the secret is scrubbed even if an OS message echoed it", async () => {
		const backend = new MemoryBackend();
		const secret = "sk-live-THIS-MUST-NOT-LEAK-1234";
		backend.failNext = bunError("ERR_SECRETS_PLATFORM_ERROR", `bad value ${secret} (code: 42)`);
		const err = (await new ApiKeyStore(backend, SERVICE, "darwin").set("openai", secret).catch((e) => e)) as SecretStoreError;
		expect(err).toBeInstanceOf(SecretStoreError);
		expect(err.message).not.toContain(secret);
		expect(String(err)).not.toContain(secret);
		expect(JSON.stringify({ ...err, message: err.message })).not.toContain(secret);
		expect(err.detail).toContain("[REDACTED]");
	});

	test("scrub and mask", () => {
		expect(scrub("a sk-123456 b sk-123456", "sk-123456")).toBe("a [REDACTED] b [REDACTED]");
		expect(mask(null)).toBe("(none)");
		expect(mask("short")).toBe("(5 bytes)");
		expect(mask("sk-proj-abcdefghijklmnop")).toBe("…mnop (24 bytes)");
	});
});

describe("migration edge cases", () => {
	test("conflict keeps the new value and leaves the old item", async () => {
		const backend = new MemoryBackend();
		const store = new ApiKeyStore(backend);
		const old = new ApiKeyStore(backend, "old.service");
		await old.set("openai", "old-value-1");
		await store.set("openai", "new-value-2");
		const [r] = await store.migrateFrom("old.service", ["openai"]);
		expect(r?.outcome).toBe("conflict-kept-new");
		expect(await store.get("openai")).toBe("new-value-2");
		expect(await old.get("openai")).toBe("old-value-1");
	});

	test("a failing backend is reported per account, not thrown", async () => {
		const backend = new MemoryBackend();
		const store = new ApiKeyStore(backend, SERVICE, "darwin");
		backend.failNext = bunError("ERR_SECRETS_USER_CANCELED", "User canceled the operation. (code: -128)");
		const [r] = await store.migrateFrom("old.service", ["openai"]);
		expect(r?.outcome).toBe("failed");
		expect(r?.detail).toStartWith("canceled");
	});
});
