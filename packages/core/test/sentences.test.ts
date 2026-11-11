import { describe, expect, test } from "bun:test";
import { joinSentences, languageCode, splitSentences } from "../src/index.ts";

const L = languageCode;
const texts = (s: string, lang?: string) => splitSentences(s, lang ? L(lang) : undefined).map((p) => p.text);

describe("splitSentences", () => {
	test("Latin punctuation, keeps separators", () => {
		expect(splitSentences("Hello there.  How are you? Fine!", L("en"))).toEqual([
			{ text: "Hello there.", trailing: "  " },
			{ text: "How are you?", trailing: " " },
			{ text: "Fine!", trailing: "" },
		]);
	});

	test("CJK full stops without spaces", () => {
		expect(texts("明日の会議は午後三時に始まります。よろしくお願いします！", "ja")).toEqual([
			"明日の会議は午後三時に始まります。",
			"よろしくお願いします！",
		]);
		expect(texts("请输入您的密码。谢谢", "zh-Hans")).toEqual(["请输入您的密码。", "谢谢"]);
	});

	test("abbreviations and initials don't end a sentence", () => {
		expect(texts("Mr. Smith arrived, e.g. at noon. Then J. Doe left.", "en")).toEqual([
			"Mr. Smith arrived, e.g. at noon.",
			"Then J. Doe left.",
		]);
		expect(texts("Das ist z.B. gut. Ja.", "de")).toEqual(["Das ist z.B. gut.", "Ja."]);
	});

	test("line breaks end sentences (UI lists, subtitles)", () => {
		expect(splitSentences("Cancel\nNext", L("en"))).toEqual([
			{ text: "Cancel", trailing: "\n" },
			{ text: "Next", trailing: "" },
		]);
	});

	test("whitespace and empty input", () => {
		expect(splitSentences("   ")).toEqual([]);
		expect(splitSentences("")).toEqual([]);
		expect(texts("  Leading space.")).toEqual(["Leading space."]);
		expect(texts("No punctuation at all")).toEqual(["No punctuation at all"]);
	});
});

describe("joinSentences", () => {
	test("spaced target from unspaced source gets spaces", () => {
		const pieces = splitSentences("明日です。元気ですか？", L("ja"));
		expect(joinSentences(["It's tomorrow.", "How are you?"], pieces, L("en"))).toBe("It's tomorrow. How are you?");
	});

	test("unspaced target drops spaces, line breaks survive", () => {
		const pieces = splitSentences("Hello. Bye.\nNext", L("en"));
		expect(joinSentences(["こんにちは。", "さようなら。", "次へ"], pieces, L("ja"))).toBe(
			"こんにちは。さようなら。\n次へ",
		);
	});

	test("partial joins use the first pieces only", () => {
		const pieces = splitSentences("A. B. C.", L("en"));
		expect(joinSentences(["x.", "y."], pieces, L("de"))).toBe("x. y.");
	});
});
