// Live cloud consent rules (live-popup.md L10, GLIM-94 #16 defaults).
import { describe, expect, test } from "bun:test";
import { liveCloudConsent, type ProviderRef } from "../../src/index.ts";

const paddle: ProviderRef = { id: "paddleocr", kind: "local", name: "On-device text recognition" };
const bergamot: ProviderRef = { id: "bergamot", kind: "local", name: "On-device translation" };
const vision: ProviderRef = { id: "cloud:google-vision", kind: "cloud", name: "Google Cloud Vision" };
const gtv2: ProviderRef = { id: "cloud:google-translate-v2", kind: "cloud", name: "Google Cloud Translation" };

describe("liveCloudConsent", () => {
	test("all local: never asks", () => {
		expect(liveCloudConsent({ ocr: paddle, translation: bergamot, remembered: [] })).toEqual({ ask: false });
		expect(liveCloudConsent({ ocr: null, translation: null, remembered: [] })).toEqual({ ask: false });
	});

	test("cloud translation: asks once, can be remembered per provider", () => {
		expect(liveCloudConsent({ ocr: paddle, translation: gtv2, remembered: [] })).toEqual({
			ask: true,
			providers: [gtv2],
			canRemember: true,
			reason: "cloud-translation",
		});
		expect(liveCloudConsent({ ocr: paddle, translation: gtv2, remembered: [gtv2.id] })).toEqual({ ask: false });
		// Remembering another provider doesn't count.
		expect(liveCloudConsent({ ocr: paddle, translation: gtv2, remembered: ["cloud:deepl"] }).ask).toBe(true);
	});

	test("cloud OCR: asks every session, even when the translator was remembered", () => {
		const r = liveCloudConsent({ ocr: vision, translation: gtv2, remembered: [gtv2.id] });
		expect(r).toEqual({ ask: true, providers: [vision, gtv2], canRemember: false, reason: "cloud-ocr" });
		expect(liveCloudConsent({ ocr: vision, translation: bergamot, remembered: [] })).toMatchObject({
			ask: true,
			providers: [vision],
			canRemember: false,
		});
	});
});
