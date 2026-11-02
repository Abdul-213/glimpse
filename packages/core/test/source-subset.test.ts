import { describe, expect, test } from "bun:test";
import { groupSourceLanguages, languageCode, sourceLanguageChoices, sourceLanguageFor } from "../src/index.ts";

describe("source-language subset (GLIM-68)", () => {
	const choices = sourceLanguageChoices("en");

	test("offers detectable or locally translatable languages, sorted by name", () => {
		const codes: string[] = choices.map((c) => c.code);
		for (const c of ["en", "ja", "ar", "zh-Hans", "zh-Hant", "ru", "hi"]) expect(codes).toContain(c);
		const names = choices.map((c) => c.name);
		expect([...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))).toEqual(names);
		expect(new Set(codes).size).toBe(codes.length);
	});

	test("flags what Glimpse can and can't do with a language", () => {
		const ja = choices.find((c) => c.code === "ja");
		expect(ja).toMatchObject({ name: "Japanese", nativeName: "日本語", detectable: true, localOcr: true });
		const he = choices.find((c) => c.code === "he");
		expect(he?.localOcr).toBe(false); // PP-OCRv5 has no Hebrew recogniser
		// GLIM-126: Vietnamese is read, but the latin recogniser drops most tone marks.
		expect(choices.find((c) => c.code === "vi")).toMatchObject({ localOcr: true, localOcrPartial: true });
		expect(ja?.localOcrPartial).toBe(false);
		expect(he?.localOcrPartial).toBe(false);
	});

	test("groups by script, Han scripts together, small scripts in Other", () => {
		const groups = groupSourceLanguages(choices, "en");
		expect(groups[0]?.key).toBe("Latn");
		expect(groups[0]?.label).toBe("Latin");
		expect(groups.at(-1)?.key).toBe("other");
		const all = groups.flatMap((g) => g.languages.map((l) => l.code));
		expect(all.length).toBe(choices.length);
		const hans = groups.find((g) => g.languages.some((l) => l.code === "zh-Hans"));
		expect(hans?.languages.some((l) => l.code === "zh-Hant")).toBe(true);
	});

	test("sourceLanguageFor normalises and rejects", () => {
		expect(sourceLanguageFor("zh-TW")).toBe(languageCode("zh-Hant"));
		expect(sourceLanguageFor("tlh")).toBeNull();
		expect(sourceLanguageFor("not a tag")).toBeNull();
	});
});
