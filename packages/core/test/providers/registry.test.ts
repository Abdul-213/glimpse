import { describe, expect, test } from "bun:test";
import {
	formatIssue,
	languageCode,
	PROVIDER_IDS,
	ProviderRegistry,
	type ProvidersConfig,
	parseOrDefault,
	routeTranslation,
} from "../../src/index.ts";
import { FakeTranslationProvider, fakeOcrFactory, fakeTranslationFactory } from "../../src/testing/index.ts";

const ja = languageCode("ja");
const en = languageCode("en");
const th = languageCode("th");
const sw = languageCode("sw");

function registry() {
	return new ProviderRegistry<{ tag: string }>()
		.register(fakeOcrFactory({ id: PROVIDER_IDS.paddleocr, name: "On-device OCR", defaultRank: 0 }))
		.register(fakeOcrFactory({ id: PROVIDER_IDS.googleVision, name: "Google Cloud Vision", kind: "cloud" }))
		.register(fakeTranslationFactory({ id: PROVIDER_IDS.small100, name: "SMaLL-100", defaultRank: 20 }))
		.register(fakeTranslationFactory({ id: PROVIDER_IDS.bergamot, name: "Bergamot", defaultRank: 10 }))
		.register(fakeTranslationFactory({ id: PROVIDER_IDS.hymt2, name: "Hy-MT2", defaultRank: null }))
		.register(
			fakeTranslationFactory({ id: PROVIDER_IDS.googleTranslate, name: "Google Cloud Translation", kind: "cloud" }),
		);
}

describe("ProviderRegistry", () => {
	test("rejects bad registrations", () => {
		const r = registry();
		expect(() => r.register(fakeOcrFactory({ id: PROVIDER_IDS.paddleocr }))).toThrow(/already registered/);
		expect(() => r.register(fakeOcrFactory({ id: "Bad Id" }))).toThrow(/invalid provider id/);
		expect(() => r.register(fakeOcrFactory({ id: "cloud:x", kind: "cloud", defaultRank: 1 }))).toThrow(/by default/);
	});

	test("default selection is local only, ranked", () => {
		expect(registry().defaultConfig()).toEqual({
			ocr: "paddleocr",
			translation: ["bergamot", "small100"],
			options: {},
		});
		expect(new ProviderRegistry().defaultConfig()).toEqual({ ocr: null, translation: [], options: {} });
	});

	test("descriptors list providers per task with the default flag", () => {
		const d = registry().descriptors("translation");
		expect(d.map((x) => [x.info.id, x.isDefault])).toEqual([
			["bergamot", true],
			["small100", true],
			["cloud:google-translate-v2", false],
			["hymt2", false],
		]);
		expect(JSON.parse(JSON.stringify(d))).toEqual(d); // plain data for RPC
	});

	test("config schema fills defaults from nothing", () => {
		const { value, issues } = parseOrDefault(registry().configSchema(), undefined);
		expect(value).toEqual(registry().defaultConfig());
		expect(issues).toEqual([]);
	});

	test("config schema repairs wrong tasks, cloud-after-local and bad options", () => {
		const input = {
			ocr: "bergamot",
			translation: ["hymt2", "bergamot", "cloud:google-translate-v2", "bergamot", "Not An Id", "future-engine"],
			options: {
				bergamot: { quality: "best", verbose: "loud" },
				"future-engine": { anything: [1, 2] },
				small100: "nope",
			},
		};
		const { value, issues } = parseOrDefault(registry().configSchema(), input);
		expect(value).toEqual({
			ocr: "paddleocr",
			translation: ["hymt2", "bergamot", "future-engine"],
			options: {
				bergamot: { quality: "best", verbose: false },
				"future-engine": { anything: [1, 2] },
			},
		} satisfies ProvidersConfig);
		expect(issues.map(formatIssue)).toEqual([
			"translation[3]: duplicate; removed",
			"translation[4]: does not match /^[a-z0-9][a-z0-9:-]*$/; removed",
			'options.small100: expected an object, got "nope"; removed',
			"ocr: bergamot is not an OCR provider; using the default",
			"translation: cloud:google-translate-v2 is a cloud provider after a local one (silent cloud fallback); removed",
			'options.bergamot.verbose: expected true or false, got "loud"; using the default',
		]);
	});

	test("cloud first is allowed (the user chose it); local fallback after it is fine", () => {
		const { value, issues } = parseOrDefault(registry().configSchema(), {
			ocr: "cloud:google-vision",
			translation: ["cloud:google-translate-v2", "bergamot"],
		});
		expect(value.translation).toEqual(["cloud:google-translate-v2", "bergamot"]);
		expect(value.ocr).toBe("cloud:google-vision");
		expect(issues).toEqual([]);
	});

	test("resolve skips providers that aren't installed and creates instances with options", () => {
		const r = registry();
		const config: ProvidersConfig = {
			ocr: "future-ocr",
			translation: ["future-engine", "small100"],
			options: { small100: { quality: "best" } },
		};
		const { ocr, translation, issues } = r.create(config, { tag: "ctx" });
		expect(ocr?.info.id).toBe("paddleocr");
		expect(translation.map((t) => t.info.id)).toEqual(["small100"]);
		expect(issues.map(formatIssue)).toEqual([
			"ocr: future-ocr is not installed; using the default",
			"translation: future-engine is not installed; skipped",
		]);
		const resolved = r.resolve(config);
		expect(resolved.translation[0]?.options).toEqual({ quality: "best", verbose: false });
	});

	test("resolve with nothing installed gives no providers", () => {
		const r = new ProviderRegistry();
		const out = r.create({ ocr: "paddleocr", translation: ["bergamot"], options: {} }, undefined);
		expect(out.ocr).toBeNull();
		expect(out.translation).toEqual([]);
	});
});

describe("routeTranslation", () => {
	test("first ready wins, then first missing, then unsupported; non-ready providers skipped", async () => {
		const enhanced = new FakeTranslationProvider({ id: "hymt2", pairs: [["ja", "en"]] });
		const bergamot = new FakeTranslationProvider({
			id: "bergamot",
			pairs: [
				["ja", "en"],
				["th", "en"],
			],
			missing: [["th", "en"]],
		});
		const small = new FakeTranslationProvider({ id: "small100", pairs: [["sw", "en"]] });
		const chain = [enhanced, bergamot, small];
		await Promise.all([bergamot.init(), small.init()]); // enhanced stays idle (not downloaded)

		const jaRoute = routeTranslation(chain, ja, en);
		expect(jaRoute.status === "ready" && jaRoute.provider.info.id).toBe("bergamot");
		await enhanced.init();
		const jaRoute2 = routeTranslation(chain, ja, en);
		expect(jaRoute2.status === "ready" && jaRoute2.provider.info.id).toBe("hymt2");

		const thRoute = routeTranslation(chain, th, en);
		expect(thRoute.status).toBe("missing");
		const swRoute = routeTranslation(chain, sw, en);
		expect(swRoute.status === "ready" && swRoute.provider.info.id).toBe("small100");
		expect(routeTranslation(chain, languageCode("ko"), en).status).toBe("unsupported");
	});
});
