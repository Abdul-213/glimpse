import { describe, expect, test } from "bun:test";
import {
	formatBytes,
	joinList,
	languageDirection,
	languageName,
	nativeLanguageName,
	progressLine,
	skeletonWidth,
	skippedLabel,
	staleAge,
	stripLayout,
} from "../src/format.ts";
import { filterLanguages, foldForSearch } from "../src/language-filter.ts";
import { nextIndex } from "../src/roving.ts";

describe("copy formatting", () => {
	test("skipped line plurals and language list", () => {
		expect(skippedLabel(1, ["Korean"])).toBe("1 block skipped · Korean");
		expect(skippedLabel(3, ["Japanese", "Korean"])).toBe("3 blocks skipped · Japanese, Korean");
		expect(skippedLabel(2, [])).toBe("2 blocks skipped");
		expect(joinList(["a", "b", "c"])).toBe("a, b, c");
	});

	test("language names via Intl", () => {
		expect(languageName("ja")).toBe("Japanese");
		expect(languageName("zh-Hant")).toBe("Traditional Chinese");
		expect(nativeLanguageName("ja")).toBe("日本語");
		expect(languageName("not a tag!")).toBe("not a tag!");
	});

	test("direction from tag, including script subtags", () => {
		expect(languageDirection("ar")).toBe("rtl");
		expect(languageDirection("he-IL")).toBe("rtl");
		expect(languageDirection("ur")).toBe("rtl");
		expect(languageDirection("en")).toBe("ltr");
		expect(languageDirection("ja")).toBe("ltr");
		expect(languageDirection("ku-Arab")).toBe("rtl");
		expect(languageDirection("pa-Arab")).toBe("rtl");
		expect(languageDirection("az-Latn")).toBe("ltr");
	});

	test("stale age buckets (live.age.*)", () => {
		const now = 10_000_000;
		expect(staleAge(now - 5_000, now)).toBe("just now");
		expect(staleAge(now - 59_999, now)).toBe("just now");
		expect(staleAge(now - 60_000, now)).toBe("1 min ago");
		expect(staleAge(now - 59 * 60_000, now)).toBe("59 min ago");
		expect(staleAge(now - 60 * 60_000, now)).toBe("over an hour ago");
		expect(staleAge(now + 1000, now)).toBe("just now");
	});

	test("bytes and the download line", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(31_000_000)).toBe("31 MB");
		expect(formatBytes(1_200_000_000)).toBe("1.2 GB");
		expect(formatBytes(412_400_000)).toBe("412 MB");
		expect(formatBytes(2_000_000_000)).toBe("2 GB");
		expect(progressLine(412_000_000, 1_200_000_000, 170)).toBe("412 MB of 1.2 GB · about 3 min left");
		expect(progressLine(412_000_000, 1_200_000_000, 20)).toBe("412 MB of 1.2 GB · less than a minute left");
		expect(progressLine(1_200_000_000, 1_200_000_000, 0)).toBe("1.2 GB of 1.2 GB");
	});

	test("skeleton width clamps to 30–100 %", () => {
		expect(skeletonWidth(50, 500)).toBe(30);
		expect(skeletonWidth(300, 500)).toBe(60);
		expect(skeletonWidth(900, 500)).toBe(100);
		expect(skeletonWidth(100, 0)).toBe(100);
	});

	test("Live strip widths", () => {
		expect(stripLayout(240)).toBe("compact");
		expect(stripLayout(299)).toBe("compact");
		expect(stripLayout(300)).toBe("regular");
		expect(stripLayout(359)).toBe("regular");
		expect(stripLayout(360)).toBe("wide");
	});
});

describe("language search", () => {
	const options = [
		{ code: "en", name: "English", nativeName: "English" },
		{ code: "es", name: "Spanish", nativeName: "Español" },
		{ code: "fr", name: "French", nativeName: "Français" },
		{ code: "ja", name: "Japanese", nativeName: "日本語" },
		{ code: "zh-Hant", name: "Chinese (Traditional)", nativeName: "繁體中文" },
		{ code: "pt-BR", name: "Portuguese (Brazil)", nativeName: "Português (Brasil)" },
	];
	const codes = (q: string) => filterLanguages(options, q).map((o) => o.code);

	test("folds accents and case", () => {
		expect(foldForSearch("  Français ")).toBe("francais");
		expect(codes("espanol")).toEqual(["es"]);
		expect(codes("FRANCAIS")).toEqual(["fr"]);
	});

	test("matches own names and codes, best first", () => {
		expect(codes("日本")).toEqual(["ja"]);
		expect(codes("ja")).toEqual(["ja"]);
		expect(codes("trad")).toEqual(["zh-Hant"]);
		expect(codes("brazil")).toEqual(["pt-BR"]);
		// "en": exact code first, then name prefixes, then substrings (French has none).
		expect(codes("en")[0]).toBe("en");
		expect(codes("")).toHaveLength(options.length);
		expect(codes("klingon")).toEqual([]);
	});
});

describe("roving index", () => {
	test("horizontal follows reading direction and wraps", () => {
		expect(nextIndex(0, 3, "ArrowRight", "horizontal")).toBe(1);
		expect(nextIndex(2, 3, "ArrowRight", "horizontal")).toBe(0);
		expect(nextIndex(0, 3, "ArrowLeft", "horizontal")).toBe(2);
		expect(nextIndex(0, 3, "ArrowLeft", "horizontal", { dir: "rtl" })).toBe(1);
		expect(nextIndex(1, 3, "ArrowDown", "horizontal")).toBeNull();
	});

	test("vertical lists stop at the ends", () => {
		expect(nextIndex(2, 3, "ArrowDown", "vertical", { wrap: false })).toBe(2);
		expect(nextIndex(0, 3, "ArrowUp", "vertical", { wrap: false })).toBe(0);
		expect(nextIndex(1, 3, "End", "vertical")).toBe(2);
		expect(nextIndex(1, 3, "Home", "vertical")).toBe(0);
		expect(nextIndex(0, 0, "ArrowDown", "vertical")).toBeNull();
	});
});
