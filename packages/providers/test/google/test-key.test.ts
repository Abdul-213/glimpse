import { describe, expect, test } from "bun:test";
import { cleanGoogleKey } from "../../src/google/common.ts";
import { FakeFetch } from "../../src/google/fake-fetch.ts";
import { testGoogleKey } from "../../src/google/test-key.ts";
import { VISION_ENDPOINT } from "../../src/ocr/google-vision/provider.ts";
import { LANGUAGES_V2_ENDPOINT } from "../../src/translation/google-v2/provider.ts";
import { errorReply, fixtureJson, TEST_KEY } from "./helpers.ts";

const languages = { json: fixtureJson("translate-languages.json") };

describe("testGoogleKey", () => {
	test("both APIs accept: ok, and no screen content is sent", async () => {
		const fake = new FakeFetch().on("GET", LANGUAGES_V2_ENDPOINT, languages).on("POST", VISION_ENDPOINT, { json: {} });
		const r = await testGoogleKey(TEST_KEY, { fetch: fake.fetch });
		expect(r).toEqual({
			ok: true,
			checks: [
				{ api: "translate", ok: true },
				{ api: "vision", ok: true },
			],
		});
		expect(fake.calls.map((c) => c.body)).toEqual([null, { requests: [] }]);
		for (const c of fake.calls) expect(c.headers["x-goog-api-key"]).toBe(TEST_KEY);
	});

	test("Vision answering 400 to the empty batch still means the key works", async () => {
		const fake = new FakeFetch().on("GET", LANGUAGES_V2_ENDPOINT, languages).on("POST", VISION_ENDPOINT, {
			status: 400,
			json: { error: { code: 400, message: "No requests", status: "INVALID_ARGUMENT" } },
		});
		expect((await testGoogleKey(TEST_KEY, { fetch: fake.fetch })).ok).toBe(true);
	});

	test("one API not enabled: reported per API with fix-it copy", async () => {
		const fake = new FakeFetch()
			.on("GET", LANGUAGES_V2_ENDPOINT, languages)
			.on("POST", VISION_ENDPOINT, errorReply("service-disabled"));
		const r = await testGoogleKey(TEST_KEY, { fetch: fake.fetch });
		expect(r.ok).toBe(false);
		expect(r.checks[0]).toEqual({ api: "translate", ok: true });
		expect(r.checks[1]).toMatchObject({ api: "vision", ok: false, problem: "api-disabled" });
		expect(r.checks[1]?.ok === false && r.checks[1].message).toContain("Cloud Vision API");
	});

	test("an invalid key fails both, even though Vision's 400 is otherwise accepted", async () => {
		const fake = new FakeFetch()
			.on("GET", LANGUAGES_V2_ENDPOINT, errorReply("key-invalid-v2-legacy"))
			.on("POST", VISION_ENDPOINT, errorReply("key-invalid"));
		const r = await testGoogleKey(TEST_KEY, { fetch: fake.fetch });
		expect(r.checks.map((c) => (c.ok ? "ok" : c.problem))).toEqual(["key-invalid", "key-invalid"]);
	});

	test("offline", async () => {
		const fake = new FakeFetch()
			.on("GET", LANGUAGES_V2_ENDPOINT, { network: "offline" })
			.on("POST", VISION_ENDPOINT, { network: "offline" });
		const r = await testGoogleKey(TEST_KEY, { fetch: fake.fetch });
		expect(r.checks.map((c) => (c.ok ? "ok" : c.problem))).toEqual(["offline", "offline"]);
	});
});

describe("cleanGoogleKey", () => {
	test("trims whitespace and quotes", () => {
		expect(cleanGoogleKey(`  "${TEST_KEY}"\n`)).toEqual({ key: TEST_KEY });
	});

	test("explains what's wrong", () => {
		expect(cleanGoogleKey("   ")).toMatchObject({ problem: expect.stringContaining("Paste") });
		expect(cleanGoogleKey("AIza abc")).toMatchObject({ problem: expect.stringContaining("spaces") });
		expect(cleanGoogleKey("hello")).toMatchObject({ problem: expect.stringContaining("doesn't look like") });
		expect(cleanGoogleKey(`${TEST_KEY}!`)).toMatchObject({ problem: expect.stringContaining("doesn't look like") });
	});
});
