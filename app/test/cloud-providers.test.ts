// GLIM-60/61: cloud providers are registered but never selected by default.
import { describe, expect, test } from "bun:test";
import { PROVIDER_IDS, ProviderRegistry } from "@glimpse/core";
import { type AppProviderContext, registerProviders } from "../src/bun/services/providers.ts";

describe("cloud providers in the app registry", () => {
	const registry = new ProviderRegistry<AppProviderContext>();
	registerProviders(registry);

	test("Google Cloud Vision is registered as an opt-in cloud OCR provider", () => {
		const vision = registry.get(PROVIDER_IDS.googleVision);
		expect(vision?.info).toMatchObject({ kind: "cloud", task: "ocr", vendor: "Google" });
		expect(vision?.defaultRank).toBeNull();
	});

	test("the default selection is local only", () => {
		const defaults = registry.defaultConfig();
		for (const id of [defaults.ocr, ...defaults.translation]) {
			expect(id === null ? "local" : registry.get(id)?.info.kind).toBe("local");
		}
	});
});
