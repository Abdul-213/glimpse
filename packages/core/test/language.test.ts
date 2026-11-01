import { describe, expect, test } from "bun:test";
import { languageCode, languageName, parseLanguageCode, primaryLanguage } from "../src/index.ts";

describe("language codes", () => {
	test("canonicalises BCP-47 tags", () => {
		expect(parseLanguageCode("EN")).toBe(languageCode("en"));
		expect(parseLanguageCode("zh-hant")).toBe(languageCode("zh-Hant"));
		expect(parseLanguageCode("pt_br")).toBe(languageCode("pt-BR"));
		expect(parseLanguageCode(" ja ")).toBe(languageCode("ja"));
	});

	test("rejects malformed tags", () => {
		expect(parseLanguageCode("")).toBeNull();
		expect(parseLanguageCode("not a tag")).toBeNull();
		expect(() => languageCode("x")).toThrow(RangeError);
	});

	test("primaryLanguage and languageName", () => {
		expect(primaryLanguage(languageCode("zh-Hant"))).toBe(languageCode("zh"));
		expect(languageName(languageCode("ja"))).toBe("Japanese");
	});
});
