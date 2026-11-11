// Integration tests against the REAL OS secret store via Bun.secrets.
// macOS: login keychain. Windows: Credential Manager. Linux: libsecret.
// If no store is reachable (e.g. headless Linux without a Secret Service), the
// suite is skipped with a message. Under scripts/linux-headless-keyring.sh
// (GLIM_HEADLESS_KEYRING=1) a missing store is a failure instead.
//
// Items written: service "dev.glimpse.app.test" (not the real service), all deleted again.
import { describe, expect, test } from "bun:test";
import { migrationProbe, runRoundTrip, sizeProbe } from "../src/shared/roundtrip";
import { ApiKeyStore, MAX_SECRET_BYTES, SecretStoreError, bunSecretsBackend, classifyError } from "../src/shared/secret-store";

const TEST_SERVICE = "dev.glimpse.app.test";
const store = new ApiKeyStore(bunSecretsBackend, TEST_SERVICE);

async function probe(): Promise<string | null> {
	try {
		await Bun.secrets.get({ service: TEST_SERVICE, name: "availability-probe" });
		return null;
	} catch (err) {
		const e = classifyError(err, "get", process.platform);
		return `${e.kind}: ${e.detail}`;
	}
}

const unavailable = await probe();
const required = process.env.GLIM_HEADLESS_KEYRING === "1" || process.env.GLIM_REQUIRE_KEYRING === "1";
if (unavailable) {
	const msg = `OS secret store not reachable on ${process.platform} (${unavailable}).`;
	if (required) {
		test("OS secret store is reachable", () => {
			throw new Error(msg);
		});
	} else {
		console.warn(
			`\n[SKIP] ${msg}\n       On headless Linux run: bun run test:linux-headless  (see TESTING.md)\n`,
		);
	}
}

describe.skipIf(!!unavailable)(`Bun.secrets on ${process.platform}`, () => {
	test("write -> read -> update -> read -> delete round trip", async () => {
		const steps = await runRoundTrip(store);
		expect(steps.filter((s) => !s.ok)).toEqual([]);
	});

	test("round trip works from a Worker thread (Electrobun runs app code in a Worker)", async () => {
		const worker = new Worker(new URL("./fixtures/roundtrip-worker.ts", import.meta.url).href);
		const result = await new Promise<{ ok: boolean; failed: unknown[] }>((resolve, reject) => {
			worker.onmessage = (e) => resolve(e.data);
			worker.onerror = (e) => reject(e);
			worker.postMessage({ service: TEST_SERVICE });
		});
		worker.terminate();
		expect(result.failed).toEqual([]);
		expect(result.ok).toBe(true);
	});

	test("service-name migration", async () => {
		const steps = await migrationProbe(store);
		expect(steps.filter((s) => !s.ok)).toEqual([]);
	});

	test("value at the app-level cap round-trips; one byte more is refused by the wrapper", async () => {
		const v = "k".repeat(MAX_SECRET_BYTES);
		await store.set("spike-cap", v);
		expect(await store.get("spike-cap")).toBe(v);
		await expect(store.set("spike-cap", v + "k")).rejects.toBeInstanceOf(SecretStoreError);
		expect(await store.delete("spike-cap")).toBe(true);
	});

	test("raw size probe (records the platform's own limit)", async () => {
		const steps = await sizeProbe(bunSecretsBackend, TEST_SERVICE);
		console.log(steps.map((s) => `  ${s.ok ? "ok  " : "FAIL"} ${s.step}: ${s.detail}`).join("\n"));
		// The app cap must always fit, everywhere.
		expect(steps[0]?.ok).toBe(true);
		if (process.platform === "win32") expect(steps[1]?.ok).toBe(false);
	});

	test("accounts are independent", async () => {
		await store.set("spike-a", "value-a-123");
		await store.set("spike-b", "value-b-456");
		expect(await store.get("spike-a")).toBe("value-a-123");
		expect(await store.get("spike-b")).toBe("value-b-456");
		await store.delete("spike-a");
		expect(await store.get("spike-b")).toBe("value-b-456");
		await store.delete("spike-b");
	});
});
