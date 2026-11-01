// GLIM-51: the font/RTL test page's samples are tagged correctly, and every script that
// isn't covered by the base stack has a :lang() rule in the generated tokens.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BIDI_CASES, SCRIPT_SAMPLES } from "../src/views/gallery/script-samples.ts";

const tokensCss = await Bun.file(
	join(import.meta.dir, "..", "..", "packages", "ui", "src", "styles", "tokens.css"),
).text();

/** Scripts the base stack (and the OS cascade behind it) is expected to render. */
const BASE_SCRIPTS = new Set(["Latn", "Cyrl", "Grek", "Geor", "Armn"]);

/** Newer CLDR (macOS's ICU) gives Urdu "Aran" (Nastaliq), a variant of Arabic; Bun on Linux gives "Arab". */
const SCRIPT_VARIANTS: Record<string, string> = { Aran: "Arab" };

describe("font and RTL test samples", () => {
	test("each sample's lang resolves to its declared script", () => {
		for (const s of SCRIPT_SAMPLES) {
			const script = new Intl.Locale(s.lang).maximize().script ?? "";
			expect(`${s.lang}: ${SCRIPT_VARIANTS[script] ?? script}`).toBe(`${s.lang}: ${s.script}`);
		}
	});

	test("covers every NLLB script group", () => {
		const scripts = new Set(SCRIPT_SAMPLES.map((s) => s.script));
		for (const s of [
			"Latn",
			"Cyrl",
			"Grek",
			"Geor",
			"Armn",
			"Ethi",
			"Tfng",
			"Arab",
			"Hebr",
			"Deva",
			"Beng",
			"Guru",
			"Gujr",
			"Orya",
			"Taml",
			"Telu",
			"Knda",
			"Mlym",
			"Sinh",
			"Thai",
			"Laoo",
			"Khmr",
			"Mymr",
			"Tibt",
			"Jpan",
			"Hans",
			"Hant",
			"Kore",
		]) {
			expect(scripts.has(s)).toBe(true);
		}
	});

	test("every non-base script has a :lang() stack in tokens.css", () => {
		for (const s of SCRIPT_SAMPLES) {
			if (BASE_SCRIPTS.has(s.script)) continue;
			expect(`${s.lang}: ${tokensCss.includes(`:lang(${s.lang})`)}`).toBe(`${s.lang}: true`);
		}
	});

	test("bidi cases cover both RTL scripts and an LTR block with embedded RTL", () => {
		const langs = new Set(BIDI_CASES.map((c) => c.lang));
		expect(langs.has("ar")).toBe(true);
		expect(langs.has("he")).toBe(true);
		expect(langs.has("en")).toBe(true);
	});
});
