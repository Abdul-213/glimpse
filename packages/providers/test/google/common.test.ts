import { describe, expect, test } from "bun:test";
import { isProviderError } from "@glimpse/core";
import { MemorySecretStore } from "@glimpse/core/testing";
import {
	callGoogle,
	classifyGoogleError,
	GOOGLE_SECRET_ID,
	GoogleError,
	type GoogleProblem,
	googleProblemCopy,
	parseGoogleErrorBody,
	problemCode,
	readGoogleKey,
} from "../../src/google/common.ts";
import { FakeFetch } from "../../src/google/fake-fetch.ts";
import { ERROR_NAMES, type ErrorName, errorReply, fixtureJson, TEST_KEY } from "./helpers.ts";

const URL = "https://translation.googleapis.com/language/translate/v2";

const call = (fake: FakeFetch, extra: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
	callGoogle({
		providerId: "cloud:google-translate-v2",
		api: "translate",
		fetch: fake.fetch,
		key: TEST_KEY,
		url: URL,
		body: { q: ["x"] },
		timeoutMs: extra.timeoutMs ?? 2000,
		signal: extra.signal,
	});

const EXPECTED: Record<ErrorName, GoogleProblem> = {
	"key-invalid": "key-invalid",
	"key-invalid-v2-legacy": "key-invalid",
	"service-disabled": "api-disabled",
	"billing-disabled": "billing-disabled",
	"key-service-blocked": "key-api-blocked",
	"referrer-blocked": "key-app-blocked",
	"rate-limited": "rate-limited",
	"quota-daily": "quota-exceeded",
	"quota-daily-legacy": "quota-exceeded",
	unavailable: "server",
};

describe("Google error mapping", () => {
	const errors = fixtureJson("errors.json") as Record<string, { status: number; body: unknown }>;

	for (const name of ERROR_NAMES) {
		test(`${name} -> ${EXPECTED[name]}`, () => {
			const e = errors[name];
			if (!e) throw new Error(name);
			expect(classifyGoogleError(e.status, parseGoogleErrorBody(e.body))).toBe(EXPECTED[name]);
		});
	}

	test("problems map onto the core vocabulary", () => {
		expect(problemCode("key-invalid")).toBe("invalid-key");
		expect(problemCode("api-disabled")).toBe("invalid-key");
		expect(problemCode("billing-disabled")).toBe("invalid-key");
		expect(problemCode("no-key")).toBe("needs-key");
		expect(problemCode("quota-exceeded")).toBe("quota-exceeded");
		expect(problemCode("rate-limited")).toBe("rate-limited");
		expect(problemCode("offline")).toBe("offline");
		expect(problemCode("server")).toBe("network");
	});

	test("user copy names the API that needs fixing", () => {
		expect(googleProblemCopy("api-disabled", "vision")).toContain("Cloud Vision API");
		expect(googleProblemCopy("api-disabled", "translate")).toContain("Cloud Translation API");
		expect(googleProblemCopy("billing-disabled", "translate")).toMatch(/billing/i);
	});

	test("bare statuses without a body", () => {
		expect(classifyGoogleError(401, { reasons: [] })).toBe("key-invalid");
		expect(classifyGoogleError(403, { reasons: [] })).toBe("permission-denied");
		expect(classifyGoogleError(429, { reasons: [] })).toBe("rate-limited");
		expect(classifyGoogleError(500, { reasons: [] })).toBe("server");
		expect(parseGoogleErrorBody("<html>")).toEqual({ reasons: [] });
	});
});

describe("callGoogle", () => {
	test("sends the key in x-goog-api-key, never in the URL", async () => {
		const fake = new FakeFetch().on("POST", URL, { json: { data: { translations: [] } } });
		await call(fake);
		const [c] = fake.calls;
		expect(c?.headers["x-goog-api-key"]).toBe(TEST_KEY);
		expect(c?.url).not.toContain(TEST_KEY);
		expect(c?.url).not.toContain("key=");
		expect(c?.headers["content-type"]).toContain("application/json");
	});

	test("an error reply becomes a GoogleError with status, reason and retry delay", async () => {
		const fake = new FakeFetch().on("POST", URL, errorReply("rate-limited"));
		const error = await call(fake).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GoogleError);
		const g = error as GoogleError;
		expect(g.code).toBe("rate-limited");
		expect(g.retryable).toBe(true);
		expect(g.retryAfterMs).toBe(7000);
		expect(g.httpStatus).toBe(429);
		expect(g.message).toContain("RATE_LIMIT_EXCEEDED");
		expect(g.providerId).toBe("cloud:google-translate-v2");
		expect(g.toInfo()).toMatchObject({ code: "rate-limited", retryAfterMs: 7000 });
	});

	test("the key is scrubbed from any message that echoes it", async () => {
		const fake = new FakeFetch().on("POST", URL, {
			status: 400,
			json: { error: { code: 400, message: `bad key ${TEST_KEY}`, status: "INVALID_ARGUMENT" } },
		});
		const error = (await call(fake).catch((e: unknown) => e)) as Error;
		expect(error.message).not.toContain(TEST_KEY);
	});

	test("connection failures are offline; other transport failures are network", async () => {
		const offline = await call(new FakeFetch().on("POST", URL, { network: "offline" })).catch((e: unknown) => e);
		expect(isProviderError(offline, "offline")).toBe(true);
		const reset = await call(new FakeFetch().on("POST", URL, { network: "reset" })).catch((e: unknown) => e);
		expect(isProviderError(reset, "network")).toBe(true);
	});

	test("a reply that isn't JSON is a network error", async () => {
		const fake: FakeFetch = new FakeFetch();
		const error = await callGoogle({
			providerId: "p",
			api: "vision",
			fetch: async () => new Response("<html>", { status: 200 }),
			key: TEST_KEY,
			url: URL,
			timeoutMs: 1000,
		}).catch((e: unknown) => e);
		expect(isProviderError(error, "network")).toBe(true);
		expect(fake.calls).toHaveLength(0);
	});

	test("timeout", async () => {
		const fake = new FakeFetch().on("POST", URL, { hang: true });
		const error = await call(fake, { timeoutMs: 30 }).catch((e: unknown) => e);
		expect(isProviderError(error, "timeout")).toBe(true);
	});

	test("abort mid-flight rejects cancelled promptly", async () => {
		const fake = new FakeFetch().on("POST", URL, { hang: true });
		const controller = new AbortController();
		const pending = call(fake, { signal: controller.signal, timeoutMs: 60_000 });
		setTimeout(() => controller.abort(), 5);
		const t0 = performance.now();
		const error = await pending.catch((e: unknown) => e);
		expect(isProviderError(error, "cancelled")).toBe(true);
		expect(performance.now() - t0).toBeLessThan(1000);
	});

	test("abort is honoured even when the fetch itself ignores the signal", async () => {
		const controller = new AbortController();
		const pending = callGoogle({
			providerId: "p",
			api: "vision",
			fetch: () => new Promise<Response>(() => {}),
			key: TEST_KEY,
			url: URL,
			timeoutMs: 60_000,
			signal: controller.signal,
		});
		controller.abort();
		expect(isProviderError(await pending.catch((e: unknown) => e), "cancelled")).toBe(true);
	});
});

describe("readGoogleKey", () => {
	test("returns the trimmed key", async () => {
		const secrets = new MemorySecretStore({ [GOOGLE_SECRET_ID]: ` ${TEST_KEY}\n` });
		expect(await readGoogleKey(secrets, "vision", "p")).toBe(TEST_KEY);
	});

	test("no key -> needs-key (no-key)", async () => {
		const error = await readGoogleKey(new MemorySecretStore(), "vision", "p").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GoogleError);
		expect((error as GoogleError).problem).toBe("no-key");
		expect((error as GoogleError).code).toBe("needs-key");
	});

	test("a locked keychain -> needs-key (keychain), naming the kind only", async () => {
		const secrets = new MemorySecretStore({ [GOOGLE_SECRET_ID]: TEST_KEY });
		secrets.failWith = "locked";
		const error = (await readGoogleKey(secrets, "translate", "p").catch((e: unknown) => e)) as GoogleError;
		expect(error.problem).toBe("keychain");
		expect(error.message).toContain("locked");
		expect(error.message).not.toContain(TEST_KEY);
	});
});
