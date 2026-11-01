// Calls the real Google APIs. Skipped unless GLIMPSE_GOOGLE_KEY is set (never in CI):
//   GLIMPSE_GOOGLE_KEY=AIza... bun test packages/providers/test/google/real-api.test.ts
// Costs: one Vision image (1 of the 1,000 free units a month).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { languageCode } from "@glimpse/core";
import { MemorySecretStore, ocrProviderContract } from "@glimpse/core/testing";
import { GOOGLE_SECRET_ID } from "../../src/google/common.ts";
import { GoogleVisionProvider } from "../../src/ocr/google-vision/provider.ts";
import { loadPng } from "../helpers/png.ts";

const key = process.env["GLIMPSE_GOOGLE_KEY"];
const secrets = () => new MemorySecretStore(key ? { [GOOGLE_SECRET_ID]: key } : {});
const T = 30_000;

describe.skipIf(!key)("Google Cloud Vision (real API)", async () => {
	const image = await loadPng(join(import.meta.dir, "..", "fixtures", "ocr", "region-en.png"));

	test(
		"reads the English fixture",
		async () => {
			const p = new GoogleVisionProvider({}, { google: { secrets: secrets() } });
			expect((await p.init()).state).toBe("ready");
			const result = await p.recognise({ image });
			const text = result.blocks.map((b) => b.text).join("\n");
			expect(text).toContain("Settings saved");
			expect(result.blocks[0]?.languageHints?.[0]?.lang).toBe(languageCode("en"));
			await p.dispose();
		},
		T,
	);

	// One contract check against the live service (the rest are covered by recorded replies).
	const [wellFormed] = ocrProviderContract(() => new GoogleVisionProvider({}, { google: { secrets: secrets() } }), {
		image,
		expectText: "Settings saved",
	}).filter((c) => c.name.startsWith("recognise: blocks are well-formed"));
	if (wellFormed) test(wellFormed.name, wellFormed.run, T);
});
