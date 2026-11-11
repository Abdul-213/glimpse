// GLIM-60/61: cloud providers are registered but never selected by default.
import { describe, expect, test } from "bun:test";
import { PROVIDER_IDS, ProviderRegistry, parseOrDefault } from "@glimpse/core";
import { type AppProviderContext, registerProviders } from "../src/bun/services/providers.ts";

describe("cloud providers in the app registry", () => {
	const registry = new ProviderRegistry<AppProviderContext>();
	registerProviders(registry);

	test("Google Cloud Vision is registered as an opt-in cloud OCR provider", () => {
		const vision = registry.get(PROVIDER_IDS.googleVision);
		expect(vision?.info).toMatchObject({ kind: "cloud", task: "ocr", vendor: "Google" });
		expect(vision?.defaultRank).toBeNull();
	});

	test("Google Cloud Translation is registered as an opt-in cloud translator", () => {
		const translate = registry.get(PROVIDER_IDS.googleTranslate);
		expect(translate?.info).toMatchObject({ kind: "cloud", task: "translation", vendor: "Google" });
		expect(translate?.defaultRank).toBeNull();
		expect(translate?.capabilities.secretId).toBe(registry.get(PROVIDER_IDS.googleVision)?.capabilities.secretId);
	});

	test("a cloud translator after a local one is dropped from the chain (no silent cloud fallback)", () => {
		const { value } = parseOrDefault(registry.configSchema(), {
			translation: [PROVIDER_IDS.bergamot, PROVIDER_IDS.googleTranslate],
		});
		expect(value.translation).toEqual([PROVIDER_IDS.bergamot]);
	});

	test("the default selection is local only", () => {
		const defaults = registry.defaultConfig();
		for (const id of [defaults.ocr, ...defaults.translation]) {
			expect(id === null ? "local" : registry.get(id)?.info.kind).toBe("local");
		}
	});
});
