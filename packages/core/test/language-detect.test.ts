// GLIM-49: the GLIM-21 detection rules with a scripted detector.
import { describe, expect, test } from "bun:test";
import {
	chineseVariant,
	type DetectInput,
	detectCaptureLanguages,
	detectionCopy,
	isNeutralToken,
	type LanguageCode,
	type LanguageDecision,
	LanguageDetectionSession,
	languageCode,
	planDetector,
	weightedLetters,
} from "../src/index.ts";
import { FakeLanguageDetector } from "../src/testing/index.ts";

const L = languageCode;
const subset = (...codes: string[]): LanguageCode[] => codes.map(L);
const block = (id: string, text: string, confidence = 0.95): DetectInput => ({ id, text, confidence });

/** Decide one block. */
function decide(
	text: string,
	opts: { subset?: LanguageCode[]; target?: string | null; detector?: FakeLanguageDetector; confidence?: number } = {},
): LanguageDecision {
	const detector = opts.detector ?? new FakeLanguageDetector();
	const r = detectCaptureLanguages([block("b", text, opts.confidence ?? 0.95)], {
		subset: opts.subset ?? [],
		target: opts.target === undefined ? L("en") : opts.target === null ? null : L(opts.target),
		detector,
	});
	const d = r.get("b");
	if (!d) throw new Error("no decision");
	return d;
}

describe("detection copy and rule 1 inputs", () => {
	test("strips URLs, e-mails, handles, tags, numbers with units, punctuation and emoji", () => {
		expect(detectionCopy("Visit https://example.com/x or mail a.b@c.de, @alice #tag!")).toBe("Visit or mail");
		expect(detectionCopy("Größe: 12 MB · 100% 🎉 3.5GHz")).toBe("Größe");
		expect(detectionCopy("Your session will expire in 5 minutes.")).toBe("Your session will expire in minutes");
		expect(detectionCopy("ｈｅｌｌｏ")).toBe("hello");
	});

	test("Han and kana count three per character", () => {
		expect(weightedLetters("設定")).toBe(6);
		expect(weightedLetters("ok")).toBe(2);
		expect(weightedLetters("설정")).toBe(2);
	});

	test("known neutral tokens", () => {
		for (const t of ["OK", "Esc", "F5", "F12", "Lv.", "HP", "v1.2.3", "USB-C", "Wi-Fi"])
			expect(isNeutralToken(t)).toBe(true);
		for (const t of ["Okay", "Settings", "F30"]) expect(isNeutralToken(t)).toBe(false);
	});

	test("Simplified vs Traditional by character", () => {
		expect(chineseVariant("请输入您的密码")).toBe("Hans");
		expect(chineseVariant("請輸入您的密碼")).toBe("Hant");
		expect(chineseVariant("密")).toBeNull();
	});
});

describe("GLIM-21 rules", () => {
	test("rule 1: junk and tokens are neutral, never skipped", () => {
		for (const t of ["OK", "100%", "F5", "@alice", "12:30", "x", "★★★"]) {
			const d = decide(t, { subset: subset("ja") });
			expect(d.language.kind).toBe("neutral");
			expect(d.rule).toBe("1");
			expect(d.translate).toBe(false);
		}
	});

	test("rule 2: a script no subset language writes is skipped with certainty", () => {
		const d = decide("설정이 저장되었습니다", { subset: subset("ja", "de") });
		expect(d).toMatchObject({ rule: "2", translate: false, language: { kind: "skipped", lang: "ko", confidence: 1 } });
		const cyr = decide("Настройки сохранены", {
			subset: subset("ja"),
			detector: new FakeLanguageDetector({ "Настройки сохранены": [["ru", 0.8]] }),
		});
		expect(cyr).toMatchObject({ rule: "2", language: { kind: "skipped", lang: "ru" } });
	});

	test("rule 3: script-unique languages, no detector call", () => {
		const detector = new FakeLanguageDetector();
		expect(decide("設定を保存しました", { subset: subset("ja"), detector })).toMatchObject({
			rule: "3",
			translate: true,
			language: { kind: "language", lang: "ja", confidence: 1 },
		});
		expect(decide("บันทึกการตั้งค่าแล้ว", { subset: subset("ja", "th"), detector }).language).toMatchObject({
			lang: "th",
		});
		// Korean with no subset: decided by script, translated.
		expect(decide("설정", { detector }).translate).toBe(true);
		expect(detector.calls).toHaveLength(0);
	});

	test("rule 3 outside the subset is a skip; the target language is shown as-is", () => {
		expect(decide("설정이 저장", { subset: subset("ja", "ko") }).translate).toBe(true);
		const ja = decide("設定を保存しました", { subset: subset("ja"), target: "ja" });
		expect(ja).toMatchObject({ translate: false, language: { kind: "language", lang: "ja" } });
	});

	test("rule 4: long Latin text with a confident detector", () => {
		const detector = new FakeLanguageDetector({
			"Die Datei konnte nicht gespeichert werden": [
				["de", 0.83],
				["nl", 0.7],
			],
		});
		const d = decide("Die Datei konnte nicht gespeichert werden.", { subset: subset("de", "fr"), detector });
		expect(d).toMatchObject({
			rule: "4",
			translate: true,
			confident: true,
			language: { lang: "de", confidence: 0.83 },
		});
		const skipped = decide("Die Datei konnte nicht gespeichert werden.", { subset: subset("fr"), detector });
		expect(skipped).toMatchObject({ rule: "4", translate: false, language: { kind: "skipped", lang: "de" } });
	});

	test("rule 4 needs reliable + tau + 8 letters + OCR confidence, else rule 5", () => {
		const detector = new FakeLanguageDetector(
			{ "Einstellungen gespeichert": [["de", 0.4]], Abbrechen: [["de", 0.9]], Weiter: [["de", 0.9]] },
			{ reliable: () => true },
		);
		expect(decide("Einstellungen gespeichert", { subset: subset("de"), detector }).rule).toBe("5c");
		expect(decide("Weiter", { subset: subset("de"), detector }).rule).toBe("5c");
		expect(decide("Abbrechen", { subset: subset("de"), detector, confidence: 0.3 }).rule).toBe("5c");
		expect(decide("Abbrechen", { subset: subset("de"), detector }).rule).toBe("4");
	});

	test("5c leans towards translating: subset language in the top 3", () => {
		const detector = new FakeLanguageDetector({
			Sair: [
				["it", 0.6],
				["pt", 0.58],
				["es", 0.5],
			],
			Cancel: [
				["en", 0.7],
				["fr", 0.6],
				["nl", 0.55],
			],
		});
		const d = decide("Sair", { subset: subset("pt"), detector });
		expect(d).toMatchObject({ rule: "5c", translate: true, language: { lang: "pt" } });
		const c = decide("Cancel", { subset: subset("de"), detector });
		expect(c).toMatchObject({ rule: "5c", translate: false, language: { kind: "skipped", lang: "en" } });
	});

	test("5c: a subset language the detector can't identify is never ruled out", () => {
		const detector = new FakeLanguageDetector({ Salamat: [["tl", 0.5]] }, { languages: ["en", "tl"] });
		// `id` (Indonesian) isn't in this detector: short Latin blocks lean to translating as id.
		const d = decide("Halo", { subset: subset("id"), detector });
		expect(d).toMatchObject({ rule: "5c", translate: true, language: { lang: "id" } });
	});

	test("5b: short blocks inherit the capture's confident majority if it writes their script", () => {
		const detector = new FakeLanguageDetector({
			"Möchten Sie die Änderungen übernehmen": [["de", 0.85]],
			"Wir sehen uns morgen am Bahnhof": [["de", 0.82]],
			Weiter: [["nl", 0.6]],
		});
		const r = detectCaptureLanguages(
			[
				block("a", "Möchten Sie die Änderungen übernehmen?"),
				block("b", "Wir sehen uns morgen am Bahnhof."),
				block("c", "Weiter"),
				block("d", "設定"),
			],
			{ subset: subset("de", "ja"), target: L("en"), detector },
		);
		expect(r.get("c")).toMatchObject({ rule: "5b", translate: true, language: { lang: "de" } });
		// Han text can't inherit German.
		expect(r.get("d")?.rule).not.toBe("5b");
	});

	describe("GLIM-140: the capture's script prior", () => {
		// ELD's real scores for the GLIM-64 cyrillic-bg-menu case.
		const menu = {
			"Нов прозорец": [
				["ru", 0.8423],
				["bg", 0.836],
				["sr", 0.8306],
			],
			"Отваряне на файл": [
				["bg", 0.8202],
				["ru", 0.8131],
				["uk", 0.8105],
			],
			"Последни документи": [
				["sr", 0.8402],
				["ru", 0.8364],
				["uk", 0.8359],
				["bg", 0.8355],
			],
			Изход: [
				["bg", 0.83],
				["sr", 0.78],
			],
			"Нов прозорец Отваряне на файл Последни документи Изход": [
				["bg", 0.8309],
				["ru", 0.8253],
			],
		} as const;
		const languages = ["en", "ru", "uk", "bg", "sr", "be", "de"];
		const menuBlocks = [
			block("a", "Нов прозорец"),
			block("b", "Отваряне на файл"),
			block("c", "Последни документи"),
			block("d", "Изход"),
		];
		const cyrillic = subset("ru", "uk", "bg", "en");

		test("short near-ties take the window's language (4w); the short item inherits it (5b)", () => {
			const detector = new FakeLanguageDetector(menu, { languages });
			const r = detectCaptureLanguages(menuBlocks, { subset: cyrillic, target: L("en"), detector });
			expect(r.get("a")).toMatchObject({ rule: "4w", translate: true, confident: true, language: { lang: "bg" } });
			expect(r.get("b")).toMatchObject({ rule: "4", language: { lang: "bg" } });
			// sr is outside the subset: without the prior this block was skipped.
			expect(r.get("c")).toMatchObject({ rule: "4w", translate: true, language: { kind: "language", lang: "bg" } });
			expect(r.get("d")).toMatchObject({ rule: "5b", language: { lang: "bg" } });
			// One extra detector call for the joined Cyrillic text.
			expect(detector.calls.filter((t) => t.includes(" Изход"))).toHaveLength(1);
		});

		test("a clear lead, a long block or a prior the block doesn't rate keeps rule 4", () => {
			const long = "Сохранить изменения в документе перед закрытием";
			const detector = new FakeLanguageDetector(
				{
					...menu,
					[long]: [
						["ru", 0.84],
						["bg", 0.835],
					],
					"Сохранить файл": [
						["ru", 0.85],
						["bg", 0.82],
					],
					"Открыть окно": [["ru", 0.85]],
					[`Нов прозорец Отваряне на файл ${long} Сохранить файл Открыть окно`]: [["bg", 0.83]],
				},
				{ languages },
			);
			const r = detectCaptureLanguages(
				[
					block("a", "Нов прозорец"),
					block("b", "Отваряне на файл"),
					block("c", long),
					block("d", "Сохранить файл"),
					block("e", "Открыть окно"),
				],
				{ subset: cyrillic, target: L("en"), detector },
			);
			expect(r.get("a")).toMatchObject({ rule: "4w", language: { lang: "bg" } });
			expect(r.get("c")).toMatchObject({ rule: "4", language: { lang: "ru" } }); // >= priorMaxLetters
			expect(r.get("d")).toMatchObject({ rule: "4", language: { lang: "ru" } }); // leads by 0.03
			expect(r.get("e")).toMatchObject({ rule: "4", language: { lang: "ru" } }); // bg not a candidate
		});

		test("no prior from one block, an unreliable joined text, or low-confidence OCR", () => {
			const one = new FakeLanguageDetector(menu, { languages });
			const single = detectCaptureLanguages([block("a", "Нов прозорец")], {
				subset: cyrillic,
				target: L("en"),
				detector: one,
			});
			expect(single.get("a")).toMatchObject({ rule: "4", language: { lang: "ru" } });
			expect(one.calls).toEqual(["Нов прозорец"]);

			const unreliable = new FakeLanguageDetector(menu, { languages, reliable: (t) => t.length >= 8 && t.length < 40 });
			const r = detectCaptureLanguages(menuBlocks, { subset: cyrillic, target: L("en"), detector: unreliable });
			expect(r.get("a")).toMatchObject({ rule: "4", language: { lang: "ru" } });

			const blurry = new FakeLanguageDetector(menu, { languages });
			const low = detectCaptureLanguages(
				menuBlocks.map((b) => ({ ...b, confidence: 0.4 })),
				{ subset: cyrillic, target: L("en"), detector: blurry },
			);
			expect(blurry.calls.filter((t) => t.includes(" Изход"))).toEqual([]);
			expect(low.get("a")?.rule).not.toBe("4w");
		});

		test("other scripts don't feed or take the Cyrillic prior", () => {
			const detector = new FakeLanguageDetector(
				{
					...menu,
					"Нов прозорец Последни документи": [["bg", 0.83]],
					"Open a new window": [["en", 0.9]],
				},
				{ languages },
			);
			const r = detectCaptureLanguages(
				[block("a", "Нов прозорец"), block("b", "Open a new window"), block("c", "Последни документи")],
				{ subset: cyrillic, target: L("de"), detector },
			);
			expect(r.get("a")).toMatchObject({ rule: "4w", language: { lang: "bg" } });
			expect(r.get("b")).toMatchObject({ rule: "4", language: { lang: "en" } });
			expect(r.get("c")).toMatchObject({ rule: "4w", language: { lang: "bg" } });
		});
	});

	test("no subset: uncertain blocks use the majority, then the detector's top-1", () => {
		const detector = new FakeLanguageDetector({ Hola: [["es", 0.6]] });
		expect(decide("Hola", { subset: [], detector })).toMatchObject({
			translate: true,
			language: { kind: "language", lang: "es" },
		});
		expect(decide("Zzz", { subset: [], detector }).language).toMatchObject({ kind: "skipped", lang: null });
	});

	test("Han-only text is ambiguous between Chinese and Japanese", () => {
		const detector = new FakeLanguageDetector({
			詳細設定: [
				["zh-Hans", 0.6],
				["ja", 0.5],
			],
		});
		// Weighted letters 12 >= 8 but not reliable (4 characters): 5c picks ja from the top 3.
		expect(decide("詳細設定", { subset: subset("ja"), detector })).toMatchObject({
			rule: "5c",
			translate: true,
			language: { lang: "ja" },
		});
	});
});

describe("planDetector", () => {
	const eld = { id: "eld", languages: ["en", "de", "fr", "ja", "zh-Hans", "zh-Hant", "ko", "th"].map(L) };
	const ft = { id: "fasttext", languages: ["en", "de", "fr", "id", "sw"].map(L) };

	test("ELD when it (or the script table) covers the subset; fastText when it doesn't", () => {
		expect(planDetector(subset("de", "ko", "el"), [eld, ft])).toEqual({ detector: eld, undetectable: [] });
		expect(planDetector(subset("de", "id"), [eld, ft])).toEqual({ detector: ft, undetectable: [] });
		expect(planDetector(subset("ja", "id"), [eld])).toEqual({ detector: eld, undetectable: [L("id")] });
		expect(planDetector([], [eld, ft]).detector).toBe(eld);
	});
});

describe("Live session: text cache and hysteresis", () => {
	test("repeat confident text skips the detector; a short block keeps its language", () => {
		const detector = new FakeLanguageDetector({
			"Wir sehen uns morgen am Bahnhof": [["de", 0.82]],
			"Ja gerne": [
				["da", 0.82],
				["de", 0.79],
			],
		});
		const s = new LanguageDetectionSession({ subset: subset("de"), target: L("en"), detector });
		const f1 = s.detect([block("k1", "Wir sehen uns morgen am Bahnhof.")]);
		expect(f1.get("k1")?.rule).toBe("4");
		const calls = detector.calls.length;
		const f2 = s.detect([block("k1", "Wir sehen uns morgen am Bahnhof.")]);
		expect(f2.get("k1")).toMatchObject({ rule: "5a", language: { lang: "de" } });
		expect(detector.calls.length).toBe(calls);

		// Same block id, now an uncertain short text that would be skipped (da isn't in the
		// subset, de is in the top 3 so 5c picks de anyway); then text the detector calls `da`.
		const f3 = s.detect([block("k1", "Ja, gerne!")]);
		expect(f3.get("k1")?.language).toMatchObject({ lang: "de" });
	});

	test("hysteresis: an uncertain different language doesn't flip a block; a confident one does", () => {
		const detector = new FakeLanguageDetector({
			"Bonjour à tous les amis": [["fr", 0.85]],
			Merci: [["en", 0.6]],
			"Guten Morgen zusammen alle": [["de", 0.9]],
		});
		const s = new LanguageDetectionSession({ subset: [], target: L("ja"), detector });
		s.detect([block("k1", "Bonjour à tous les amis")]);
		expect(s.detect([block("k1", "Merci")]).get("k1")).toMatchObject({
			rule: "hysteresis",
			language: { lang: "fr" },
		});
		expect(s.detect([block("k1", "Guten Morgen zusammen alle")]).get("k1")).toMatchObject({
			rule: "4",
			language: { lang: "de" },
		});
		s.reset();
		expect(s.detect([block("k1", "Merci")]).get("k1")?.language).toMatchObject({ lang: "en" });
	});
});

describe("OCR language hints (Google Vision detectedLanguages) as a prior", () => {
	const hinted = (text: string, lang: string, confidence = 0.9): DetectInput => ({
		id: "b",
		text,
		confidence: 0.95,
		hints: [{ lang: L(lang), confidence }],
	});

	test("never decide on their own: a confident detector still wins (rule 4)", () => {
		const detector = new FakeLanguageDetector({ "Gracias por todo amigos": [["es", 0.9]] });
		const r = detectCaptureLanguages([hinted("Gracias por todo amigos", "pt")], {
			subset: [],
			target: L("en"),
			detector,
		});
		expect(r.get("b")).toMatchObject({ rule: "4", language: { lang: "es" } });
	});

	test("stand in when the detector has nothing (short text, no subset)", () => {
		const r = detectCaptureLanguages([hinted("Ok sim", "pt")], { subset: [], target: L("en"), detector: null });
		expect(r.get("b")).toMatchObject({ rule: "5c", language: { kind: "language", lang: "pt" } });
	});

	test("tried first in 5c when they name a subset language", () => {
		const detector = new FakeLanguageDetector({
			Salut: [
				["fr", 0.4],
				["de", 0.3],
			],
		});
		const r = detectCaptureLanguages([hinted("Salut", "de", 0.7)], {
			subset: subset("fr", "de"),
			target: L("en"),
			detector,
		});
		expect(r.get("b")).toMatchObject({ rule: "5c", language: { lang: "de" } });
	});

	test("a hint for another script is ignored", () => {
		const r = detectCaptureLanguages([hinted("Ok sim", "ja")], { subset: [], target: L("en"), detector: null });
		expect(r.get("b")?.language).toMatchObject({ kind: "skipped" });
	});
});
