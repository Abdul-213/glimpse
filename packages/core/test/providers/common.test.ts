import { describe, expect, test } from "bun:test";
import {
	abortable,
	fingerprintKey,
	hashString,
	isAbortError,
	isProviderError,
	isProviderId,
	languageCode,
	languageMapFromTable,
	ProviderError,
	StatusCell,
	stableHash,
	stableStringify,
} from "../../src/index.ts";

describe("provenance helpers", () => {
	test("stableStringify sorts keys at every level", () => {
		expect(stableStringify({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: undefined } })).toBe(
			'{"a":{"d":[2,{"x":2,"y":1}]},"b":1}',
		);
		expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
		expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
	});

	test("hashString is deterministic and 14 hex chars", () => {
		expect(hashString("hello")).toBe(hashString("hello"));
		expect(hashString("hello")).toMatch(/^[0-9a-f]{14}$/);
		expect(hashString("hello")).not.toBe(hashString("hellp"));
	});

	test("provider ids", () => {
		for (const id of ["bergamot", "small100", "cloud:google-translate-v2", "paddleocr"])
			expect(isProviderId(id)).toBe(true);
		for (const id of ["", "Bergamot", "a b", "cloud:", ":x", "a:b:c"]) expect(isProviderId(id)).toBe(false);
		expect(fingerprintKey({ providerId: "bergamot", modelRevision: "r1", optionsHash: "h" })).toBe("bergamot|r1|h");
	});
});

describe("ProviderError", () => {
	test("round-trips through plain data", () => {
		const e = new ProviderError("rate-limited", "slow down", { providerId: "cloud:x", retryAfterMs: 500 });
		expect(e.retryable).toBe(true);
		const info = e.toInfo();
		expect(info).toEqual({
			code: "rate-limited",
			message: "slow down",
			retryable: true,
			providerId: "cloud:x",
			retryAfterMs: 500,
		});
		expect(ProviderError.fromInfo(info).toInfo()).toEqual(info);
	});

	test("from() maps AbortErrors to cancelled and others to internal", () => {
		const abort = new DOMException("aborted", "AbortError");
		expect(isAbortError(abort)).toBe(true);
		expect(ProviderError.from(abort).code).toBe("cancelled");
		expect(ProviderError.from(new Error("boom"), "p").toInfo()).toMatchObject({ code: "internal", providerId: "p" });
	});

	test("abortable rejects when the signal fires", async () => {
		const controller = new AbortController();
		const never = new Promise<void>(() => {});
		const run = abortable(never, controller.signal, "p");
		controller.abort();
		expect(isProviderError(await run.catch((e: unknown) => e), "cancelled")).toBe(true);
		expect(await abortable(Promise.resolve(3), new AbortController().signal)).toBe(3);
	});
});

describe("StatusCell", () => {
	test("notifies listeners and freezes once disposed", () => {
		const cell = new StatusCell();
		const seen: string[] = [];
		const off = cell.subscribe((s) => seen.push(s.state));
		cell.set({ state: "loading" });
		cell.set({ state: "disposed" });
		cell.set({ state: "ready" });
		off();
		expect(seen).toEqual(["loading", "disposed"]);
		expect(cell.status.state).toBe("disposed");
	});
});

describe("languageMapFromTable", () => {
	test("maps exact tags, falls back to the primary subtag, maps back", () => {
		const map = languageMapFromTable({ "zh-Hant": "zh_hant", zh: "zh", pt: "pt", ja: "jpn_Jpan" });
		expect(map.toProvider(languageCode("zh-Hant"))).toBe("zh_hant");
		expect(map.toProvider(languageCode("pt-BR"))).toBe("pt");
		expect(map.toProvider(languageCode("ko"))).toBeNull();
		expect(map.fromProvider("jpn_Jpan")).toBe(languageCode("ja"));
		expect(map.fromProvider("xxx")).toBeNull();
		expect(() => languageMapFromTable({ "not a tag": "x" })).toThrow(RangeError);
	});
});

test("isProviderError narrows by code", () => {
	expect(isProviderError(new ProviderError("offline", "x"), "offline")).toBe(true);
	expect(isProviderError(new ProviderError("offline", "x"), "network")).toBe(false);
	expect(isProviderError(new Error("x"))).toBe(false);
});
