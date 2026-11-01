// GLIM-49 with the real ELD medium database: the adapter's label mapping, then the GLIM-21
// rules end to end on UI, chat and game strings like the GLIM-21 smoke set.
import { describe, expect, test } from "bun:test";
import {
	type DetectInput,
	detectCaptureLanguages,
	type LanguageCode,
	LanguageDetectionSession,
	languageCode,
	planDetector,
} from "@glimpse/core";
import { loadEldDetector } from "../../src/language-detect/eld.ts";

const L = languageCode;
const eld = await loadEldDetector();
const blocks = (texts: readonly string[]): DetectInput[] =>
	texts.map((text, i) => ({ id: `b${i}`, text, confidence: 0.95 }));

function run(texts: readonly string[], subset: readonly string[], target = "en") {
	const r = detectCaptureLanguages(blocks(texts), { subset: subset.map(L), target: L(target), detector: eld });
	return texts.map((_, i) => r.get(`b${i}`));
}

describe("ELD adapter", () => {
	test("60 languages as BCP-47, Chinese split by script", () => {
		expect(eld.languages.length).toBeGreaterThanOrEqual(60);
		for (const c of ["en", "de", "ja", "ko", "zh-Hans", "zh-Hant", "nb", "ar"]) expect(eld.languages).toContain(L(c));
	});

	test("labels map to catalogue codes; zh by character", () => {
		expect(eld.detect("Die Datei konnte nicht gespeichert werden").candidates[0]?.lang).toBe(L("de"));
		expect(eld.detect("请输入您的密码").candidates[0]?.lang).toBe(L("zh-Hans"));
		expect(eld.detect("請輸入您的密碼").candidates[0]?.lang).toBe(L("zh-Hant"));
		const r = eld.detect("Hola, cómo te llamas");
		expect(r.reliable).toBe(true);
		for (const c of r.candidates) expect(c.score).toBeGreaterThanOrEqual(0);
	});

	test("about 0.05 ms per block (GLIM-21), well inside the Live budget", () => {
		const texts = ["Settings saved successfully", "Möchten Sie die Änderungen übernehmen", "Вы хотите установить"];
		const t0 = performance.now();
		for (let i = 0; i < 300; i++) eld.detect(texts[i % 3] as string);
		expect((performance.now() - t0) / 300).toBeLessThan(2);
	});
});

describe("GLIM-21 rules with ELD", () => {
	test("subset {es, pt, it, fr}: junk neutral, other scripts skipped, Romance blocks translated", () => {
		const texts = [
			"OK",
			"100%",
			"@alice",
			"F5",
			"¿Quieres guardar los cambios antes de salir?",
			"Você quer instalar a atualização agora?",
			"Vuoi salvare le modifiche prima di uscire?",
			"Voulez-vous enregistrer les modifications ?",
			"Die Datei konnte nicht gespeichert werden.",
			"設定を保存しました",
			"설정이 저장되었습니다",
			"Настройки сохранены",
		];
		const d = run(texts, ["es", "pt", "it", "fr"]);
		for (const x of d.slice(0, 4)) expect(x?.language.kind).toBe("neutral");
		expect(d.slice(4, 8).map((x) => (x?.language.kind === "language" ? String(x.language.lang) : null))).toEqual([
			"es",
			"pt",
			"it",
			"fr",
		]);
		expect(d.slice(4, 8).every((x) => x?.translate)).toBe(true);
		expect(d[8]).toMatchObject({ translate: false, language: { kind: "skipped", lang: "de" } });
		for (const x of d.slice(9)) expect(x).toMatchObject({ rule: "2", translate: false, language: { kind: "skipped" } });
	});

	test("subset {ja, de}: Japanese by script, German by detector, English skipped, short German inherits", () => {
		const texts = [
			"設定を保存しました",
			"詳細設定",
			"Die Datei konnte nicht gespeichert werden.",
			"Wir sehen uns morgen am Bahnhof.",
			"Weiter",
			"Do you want to install the update now?",
		];
		const d = run(texts, ["ja", "de"]);
		expect(d[0]).toMatchObject({ rule: "3", translate: true, language: { lang: "ja" } });
		expect(d[1]?.translate).toBe(true);
		expect(d[2]).toMatchObject({ rule: "4", language: { lang: "de" } });
		expect(d[3]?.language).toMatchObject({ lang: "de" });
		expect(d[4]).toMatchObject({ translate: true, language: { lang: "de" } });
		expect(d[5]).toMatchObject({ translate: false, language: { kind: "skipped", lang: "en" } });
	});

	test("target-language blocks are shown as-is, not counted as skipped", () => {
		const d = run(["Do you want to install the update now?"], ["de", "en"], "en");
		expect(d[0]).toMatchObject({ translate: false, language: { kind: "language", lang: "en" } });
	});

	test("Chinese variants: a zh-Hans subset still translates Traditional text", () => {
		const d = run(["請輸入您的密碼，然後按下確定。"], ["zh-Hans"]);
		expect(d[0]).toMatchObject({ translate: true, language: { lang: "zh-Hant" } });
	});

	test("Live: subtitles keep their language while lines scroll", () => {
		const s = new LanguageDetectionSession({
			subset: ["de", "fr"].map(L) as LanguageCode[],
			target: L("en"),
			detector: eld,
		});
		const a = s.detect([{ id: "k1", text: "Vergiss nicht, das Update zu installieren.", confidence: 0.95 }]);
		expect(a.get("k1")?.language).toMatchObject({ lang: "de" });
		const b = s.detect([{ id: "k1", text: "Ja, gerne!", confidence: 0.95 }]);
		expect(b.get("k1")?.language).toMatchObject({ lang: "de" });
	});

	test("planDetector: ELD covers common subsets; Indonesian is undetectable without fastText", () => {
		expect(planDetector(["de", "ja", "ko"].map(L), [eld]).undetectable).toEqual([]);
		expect(planDetector(["id"].map(L), [eld]).undetectable).toEqual([L("id")]);
	});
});
