// GLIM-57: offline and model-missing states.
import { describe, expect, test } from "bun:test";
import {
	type Availability,
	type LanguageCode,
	languageCode,
	type ModelResource,
	packMissingSummary,
	packRows,
	segmentFailureKind,
	translationReadiness,
} from "../../src/index.ts";
import { FakeTranslationProvider } from "../../src/testing/index.ts";

const L = languageCode;

async function chain(...providers: FakeTranslationProvider[]) {
	for (const p of providers) await p.init();
	return providers;
}

const needs = (missing: readonly ModelResource[]): Availability => ({
	kind: "needs-download",
	ids: missing.map((m) => m.id),
	bytes: 31_000_000,
});

describe("translationReadiness", () => {
	test("ready when a provider has the pair", async () => {
		const c = await chain(new FakeTranslationProvider({ id: "bergamot", pairs: [["ja", "en"]] }));
		expect(translationReadiness(c, L("ja"), L("en"), needs)).toEqual({ state: "ready", providerId: "bergamot" });
	});

	test("missing pack: needs-download, downloading, offline, failed follow the model manager", async () => {
		const c = await chain(
			new FakeTranslationProvider({ id: "bergamot", pairs: [["th", "en"]], missing: [["th", "en"]] }),
		);
		const r = (a: Availability) => translationReadiness(c, L("th"), L("en"), () => a);
		expect(r({ kind: "needs-download", ids: ["x"], bytes: 31_000_000 })).toMatchObject({
			state: "needs-download",
			providerId: "bergamot",
			bytes: 31_000_000,
			missing: [{ id: "bergamot:th-en" }],
		});
		expect(r({ kind: "downloading", progress: 0.5 })).toMatchObject({ state: "downloading", progress: 0.5 });
		expect(r({ kind: "offline", ids: ["x"] })).toMatchObject({ state: "offline" });
		expect(r({ kind: "failed", ids: ["x"], error: { kind: "checksum", message: "bad" } })).toMatchObject({
			state: "download-failed",
			error: { kind: "checksum" },
		});
		expect(r({ kind: "ready" })).toMatchObject({ state: "downloading", progress: 1 });
	});

	test("a ready later provider beats a missing pack in an earlier one (no prompt needed)", async () => {
		const c = await chain(
			new FakeTranslationProvider({ id: "bergamot", pairs: [["th", "en"]], missing: [["th", "en"]] }),
			new FakeTranslationProvider({ id: "small100", pairs: "any" }),
		);
		expect(translationReadiness(c, L("th"), L("en"), needs)).toEqual({ state: "ready", providerId: "small100" });
	});

	test("providers that aren't ready are skipped; nothing serves it → unsupported", async () => {
		const notReady = new FakeTranslationProvider({
			id: "bergamot",
			initStatus: { state: "model-missing", missing: [] },
		});
		await notReady.init();
		expect(translationReadiness([notReady], L("ja"), L("en"), needs)).toEqual({ state: "unsupported" });
	});
});

describe("packRows and the E2 summary", () => {
	const states: Record<string, ReturnType<typeof translationReadiness>> = {
		th: {
			state: "needs-download",
			providerId: "bergamot",
			missing: [{ id: "bergamot-th-en", name: "Thai → English", bytes: 31 }],
			bytes: 31,
		},
		ko: {
			state: "offline",
			providerId: "bergamot",
			missing: [{ id: "bergamot-ko-en", name: "Korean → English", bytes: 40 }],
		},
		ja: { state: "ready", providerId: "bergamot" },
	};
	const readinessOf = (from: LanguageCode) => states[from] ?? { state: "unsupported" as const };

	test("one row per missing source language, in first-seen order, with its blocks", () => {
		const rows = packRows(
			[
				{ id: "b1", from: L("ko") },
				{ id: "b2", from: L("ja") },
				{ id: "b3", from: L("th") },
				{ id: "b4", from: L("ko") },
			],
			readinessOf,
		);
		expect(rows).toEqual([
			{
				lang: L("ko"),
				state: "offline",
				resourceIds: ["bergamot-ko-en"],
				bytes: 40,
				progress: null,
				segmentIds: ["b1", "b4"],
			},
			{
				lang: L("th"),
				state: "missing",
				resourceIds: ["bergamot-th-en"],
				bytes: 31,
				progress: null,
				segmentIds: ["b3"],
			},
		]);
		// b2 translates, so this is the partial case (rows above the list), not E2.
		expect(packMissingSummary(rows, 4)).toBeNull();
	});

	test("every block waiting on packs → E2; offline means no Download button", () => {
		const online = packRows([{ id: "b1", from: L("th") }], readinessOf);
		expect(packMissingSummary(online, 1)).toEqual({
			kind: "packMissing",
			languages: [L("th")],
			bytes: 31,
			canDownload: true,
			offline: false,
		});
		const offline = packRows([{ id: "b1", from: L("ko") }], readinessOf);
		expect(packMissingSummary(offline, 1)).toMatchObject({ canDownload: false, offline: true });
	});
});

test("segmentFailureKind maps provider errors to the popup error kinds", () => {
	expect(segmentFailureKind({ code: "model-missing" })).toBe("packMissing");
	expect(segmentFailureKind({ code: "offline" })).toBe("offline");
	expect(segmentFailureKind({ code: "invalid-key" })).toBe("providerKey");
	expect(segmentFailureKind({ code: "rate-limited" })).toBe("providerQuota");
	expect(segmentFailureKind({ code: "timeout" })).toBe("providerTimeout");
	expect(segmentFailureKind({ code: "internal" })).toBe("failed");
});
