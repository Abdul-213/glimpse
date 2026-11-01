// GLIM-18 spike: the write -> read -> update -> delete round trip and the
// other probes, shared by the CLI, the Electrobun app and the tests.
// Step details never contain secret values: only lengths, fingerprints of
// random test markers, and OS error text.
import { ApiKeyStore, SecretStoreError, fingerprint, MAX_SECRET_BYTES, type SecretBackend } from "./secret-store";

export interface Step {
	step: string;
	ok: boolean;
	ms: number;
	detail: string;
}

export const ROUNDTRIP_ACCOUNT = "spike-roundtrip";
export const MARKER_ACCOUNT = "spike-marker";
export const OLD_SERVICE = "dev.glimpse.app.old-name";

function randomValue(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function describe(err: unknown): string {
	if (err instanceof SecretStoreError) return `${err.kind}: ${err.message} | UI: "${err.userMessage}"`;
	const e = err as { code?: string; message?: string };
	return `${e?.code ?? "?"}: ${e?.message ?? String(err)}`;
}

async function timed(steps: Step[], step: string, fn: () => Promise<string>): Promise<boolean> {
	const t0 = performance.now();
	try {
		const detail = await fn();
		steps.push({ step, ok: true, ms: Math.round(performance.now() - t0), detail });
		return true;
	} catch (err) {
		steps.push({ step, ok: false, ms: Math.round(performance.now() - t0), detail: describe(err) });
		return false;
	}
}

function expect(cond: boolean, what: string): void {
	if (!cond) throw new Error(`check failed: ${what}`);
}

/** write -> read -> update -> read -> delete -> read -> delete again. */
export async function runRoundTrip(store: ApiKeyStore, account = ROUNDTRIP_ACCOUNT): Promise<Step[]> {
	const steps: Step[] = [];
	const v1 = randomValue("glim-test-v1");
	// Non-ASCII on purpose: Windows stores UTF-8 bytes, check they come back intact.
	const v2 = randomValue("glim-test-v2-ключ-鍵-🔑");

	await timed(steps, "pre-clean (delete leftovers)", async () => `deleted=${await store.delete(account)}`);
	if (!(await timed(steps, "write v1", async () => {
		await store.set(account, v1);
		return `fp=${fingerprint(v1)} len=${v1.length}`;
	}))) return steps;
	await timed(steps, "read == v1", async () => {
		const got = await store.get(account);
		expect(got === v1, `read returned ${got === null ? "null" : `fp=${fingerprint(got)}`}`);
		return `fp=${fingerprint(got!)}`;
	});
	await timed(steps, "update to v2 (non-ASCII)", async () => {
		await store.set(account, v2);
		return `fp=${fingerprint(v2)}`;
	});
	await timed(steps, "read == v2", async () => {
		const got = await store.get(account);
		expect(got === v2, `read returned ${got === null ? "null" : `fp=${fingerprint(got)}`}`);
		return `fp=${fingerprint(got!)}`;
	});
	await timed(steps, "delete", async () => {
		const deleted = await store.delete(account);
		expect(deleted, "delete returned false");
		return "deleted=true";
	});
	await timed(steps, "read after delete == null", async () => {
		const got = await store.get(account);
		expect(got === null, "item still present");
		return "null";
	});
	await timed(steps, "delete again == false", async () => {
		const deleted = await store.delete(account);
		expect(!deleted, "second delete returned true");
		return "deleted=false";
	});
	await timed(steps, "empty value is rejected (not a silent delete)", async () => {
		try {
			await store.set(account, "");
		} catch (err) {
			expect(err instanceof SecretStoreError && err.kind === "invalid", "wrong error");
			return "rejected before the OS call";
		}
		throw new Error("empty value was accepted");
	});
	return steps;
}

/** Persist a known random marker so a later run (after a rebuild) can read it back. */
export async function writeMarker(store: ApiKeyStore): Promise<Step[]> {
	const steps: Step[] = [];
	const v = randomValue("glim-marker");
	await timed(steps, "write marker", async () => {
		await store.set(MARKER_ACCOUNT, v);
		return `fp=${fingerprint(v)} (note this; read-marker must print the same fp)`;
	});
	return steps;
}

export async function readMarker(store: ApiKeyStore): Promise<Step[]> {
	const steps: Step[] = [];
	await timed(steps, "read marker", async () => {
		const got = await store.get(MARKER_ACCOUNT);
		if (got === null) return "NOT FOUND (null)";
		return `fp=${fingerprint(got)}`;
	});
	return steps;
}

export async function deleteMarker(store: ApiKeyStore): Promise<Step[]> {
	const steps: Step[] = [];
	await timed(steps, "delete marker", async () => `deleted=${await store.delete(MARKER_ACCOUNT)}`);
	return steps;
}

/** Raw size limits: bypass the wrapper's cap and ask the OS directly. */
export async function sizeProbe(backend: SecretBackend, service: string): Promise<Step[]> {
	const steps: Step[] = [];
	const account = "spike-size-probe";
	for (const bytes of [MAX_SECRET_BYTES, MAX_SECRET_BYTES + 1, 4096, 65536]) {
		const v = "x".repeat(bytes);
		const t0 = performance.now();
		try {
			await backend.set(service, account, v);
			const got = await backend.get(service, account);
			steps.push({
				step: `raw set ${bytes} bytes`,
				ok: true,
				ms: Math.round(performance.now() - t0),
				detail: got === v ? "stored and read back intact" : `stored but read back ${got?.length ?? "null"} chars`,
			});
		} catch (err) {
			steps.push({ step: `raw set ${bytes} bytes`, ok: false, ms: Math.round(performance.now() - t0), detail: describe(err) });
		}
	}
	await backend.delete(service, account).catch(() => false);
	return steps;
}

/** Service rename: seed keys under OLD_SERVICE, migrate into store.service, verify. */
export async function migrationProbe(store: ApiKeyStore): Promise<Step[]> {
	const steps: Step[] = [];
	const old = new ApiKeyStore(store.backend, OLD_SERVICE, store.platform);
	const accounts = ["spike-migrate-a", "spike-migrate-b"];
	const values = accounts.map((a) => randomValue(`glim-mig-${a}`));
	await timed(steps, "seed old service", async () => {
		for (const [i, a] of accounts.entries()) {
			await store.delete(a);
			await old.set(a, values[i]!);
		}
		return `${accounts.length} items under ${OLD_SERVICE}`;
	});
	await timed(steps, "migrate", async () => {
		const res = await store.migrateFrom(OLD_SERVICE, accounts);
		expect(res.every((r) => r.outcome === "moved"), JSON.stringify(res));
		return res.map((r) => `${r.account}=${r.outcome}`).join(", ");
	});
	await timed(steps, "verify new present, old gone", async () => {
		for (const [i, a] of accounts.entries()) {
			expect((await store.get(a)) === values[i], `${a} missing under new service`);
			expect((await old.get(a)) === null, `${a} still under old service`);
		}
		return "ok";
	});
	await timed(steps, "re-run migrate is a no-op", async () => {
		const res = await store.migrateFrom(OLD_SERVICE, accounts);
		expect(res.every((r) => r.outcome === "already-migrated"), JSON.stringify(res));
		return res.map((r) => `${r.account}=${r.outcome}`).join(", ");
	});
	await timed(steps, "cleanup", async () => {
		for (const a of accounts) await store.delete(a);
		return "ok";
	});
	return steps;
}

export function formatSteps(steps: Step[]): string {
	return steps.map((s) => `${s.ok ? "PASS" : "FAIL"}  ${s.step.padEnd(44)} ${String(s.ms).padStart(5)} ms  ${s.detail}`).join("\n");
}
