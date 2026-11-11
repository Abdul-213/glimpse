// Comparison only: does @napi-rs/keyring (keyring-rs via N-API) load and work
// under Bun? Not used by the app. Skipped when no OS store is reachable.
import { describe, expect, test } from "bun:test";

const SERVICE = "dev.glimpse.app.test-napi";
// Without this, @napi-rs/keyring silently falls back to the in-memory kernel
// keyutils store on Linux when no Secret Service is running (lost on reboot).
const OPTS = { linux: { store: "secret-service" as const } };

let loadError: string | null = null;
let Entry: typeof import("@napi-rs/keyring").Entry | null = null;
try {
	Entry = (await import("@napi-rs/keyring")).Entry;
} catch (err) {
	loadError = `cannot load @napi-rs/keyring: ${(err as Error).message}`;
}

let storeError: string | null = null;
if (Entry) {
	try {
		new Entry(SERVICE, "availability-probe", OPTS).getPassword();
	} catch (err) {
		storeError = (err as Error).message;
	}
}

const skip = !!loadError || !!storeError;
if (skip) console.warn(`\n[SKIP] @napi-rs/keyring comparison: ${loadError ?? storeError}\n`);

describe.skipIf(skip)("@napi-rs/keyring under Bun (comparison)", () => {
	test("round trip", () => {
		const e = new Entry!(SERVICE, "spike-napi", OPTS);
		e.setPassword("napi-v1");
		expect(e.getPassword()).toBe("napi-v1");
		e.setPassword("napi-v2-ключ");
		expect(e.getPassword()).toBe("napi-v2-ключ");
		expect(e.deletePassword()).toBe(true);
		expect(e.getPassword()).toBeNull();
	});

	test("interop: can it read an item written by Bun.secrets? (recorded, not asserted)", async () => {
		await Bun.secrets.set({ service: SERVICE, name: "spike-interop", value: "from-bun" });
		let seen: string | null | undefined;
		try {
			seen = new Entry!(SERVICE, "spike-interop", OPTS).getPassword();
		} catch {
			seen = undefined;
		}
		await Bun.secrets.delete({ service: SERVICE, name: "spike-interop" });
		// Recorded, not asserted: on macOS both use service+account so they likely interoperate;
		// on Windows the TargetName format differs; on Linux the schema/attributes differ.
		console.log(`  @napi-rs/keyring read of a Bun.secrets item on ${process.platform}: ${seen === "from-bun" ? "SAME VALUE" : String(seen)}`);
	});
});
