// GLIM-104 with the real fastText lid.176.ftz: the adapter's label mapping, detector choice
// for subsets ELD can't cover, and the GLIM-21 rules end to end on Indonesian and Swahili.
//
// The model file is the one `bun run models -- --all` fetches (app/models/manifest.json,
// sha256-checked), or, without that cache, the byte-identical copy fasttext.wasm.js ships in
// node_modules (used here as a test fixture only; the app never loads or ships it).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	type DetectInput,
	detectCaptureLanguages,
	type LanguageDetector,
	languageCode,
	planDetector,
	sourceLanguageChoices,
} from "@glimpse/core";
import { loadEldDetector } from "../../src/language-detect/eld.ts";
import {
	type EmVector,
	FASTTEXT_RELIABLE,
	FASTTEXT_TUNING,
	FastTextLanguageDetector,
	type FastTextNative,
	loadFastTextDetector,
} from "../../src/language-detect/fasttext.ts";

const L = languageCode;
const SHA = "8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83";
const cache = process.env["GLIMPSE_MODEL_CACHE"] ?? join(process.env["HOME"] ?? "", ".cache", "glimpse", "models");
const fromCache = join(cache, "sha256", SHA);
const fromPackage = join(
	import.meta.dir,
	"..",
	"..",
	"node_modules",
	"fasttext.wasm.js",
	"dist",
	"models",
	"language-identification",
	"assets",
	"lid.176.ftz",
);
const modelPath = existsSync(fromCache) ? fromCache : fromPackage;

const ft = await loadFastTextDetector({ modelPath });
const eld = await loadEldDetector();
const blocks = (texts: readonly string[]): DetectInput[] =>
	texts.map((text, i) => ({ id: `b${i}`, text, confidence: 0.95 }));

describe("fastText adapter (real lid.176)", () => {
	test("176 labels as BCP-47: the languages ELD lacks, Chinese split by script", () => {
		expect(ft.id).toBe("fasttext-lid176");
		expect(ft.languages.length).toBeGreaterThanOrEqual(170);
		for (const c of ["id", "sw", "uz", "en", "zh-Hans", "zh-Hant", "nb"]) expect(ft.languages).toContain(L(c));
		for (const c of ["id", "sw", "uz"]) expect(eld.languages).not.toContain(L(c));
	});

	test("labels map to catalogue codes; probabilities in 0..1; reliable at p >= 0.5", () => {
		const id = ft.detect("Apakah Anda yakin ingin menghapus file ini?");
		expect(id.candidates[0]?.lang).toBe(L("id"));
		const sw = ft.detect("Usafirishaji bure kwa oda zote");
		expect(sw.candidates[0]?.lang).toBe(L("sw"));
		expect(sw.reliable).toBe((sw.candidates[0]?.score ?? 0) >= FASTTEXT_RELIABLE);
		expect(ft.detect("Bonjour tout le monde").reliable).toBe(true);
		for (const c of id.candidates) {
			expect(c.score).toBeGreaterThanOrEqual(0);
			expect(c.score).toBeLessThanOrEqual(1);
		}
		expect(ft.detect("请输入您的密码").candidates[0]?.lang).toBe(L("zh-Hans"));
	});

	test("multi-line blocks are read as one line; empty text has no candidates", () => {
		expect(ft.detect("Apakah Anda yakin\ningin menghapus file ini?").candidates[0]?.lang).toBe(L("id"));
		expect(ft.detect("   \n ")).toEqual({ candidates: [], reliable: false });
	});

	test("words lid.176 has no n-grams for are no evidence, not English (GLIM-145)", () => {
		for (const t of ["Jumla", "Batal", "Sasisha programu", "qwzxv"]) {
			expect(ft.detect(t)).toEqual({ candidates: [], reliable: false, noEvidence: true });
		}
		expect(ft.detect("Mipangilio").noEvidence).toBeUndefined();
	});

	test("its own tuning (GLIM-142, on probabilities); ELD keeps GLIM-140's", () => {
		expect((ft as LanguageDetector).tuning).toEqual({ tau: 0.5, priorMargin: 0.7, priorMaxLetters: 48 });
		expect(FASTTEXT_RELIABLE).toBe(FASTTEXT_TUNING.tau);
		expect(eld.tuning).toEqual({ priorMargin: 0.01, priorMaxLetters: 24 });
	});
});

describe("GLIM-21 with fastText (GLIM-104)", () => {
	test("planDetector keeps ELD when it covers the subset and picks fastText for one with id", () => {
		expect(planDetector([L("ja"), L("de")], [eld, ft]).detector).toBe(eld);
		const plan = planDetector([L("ja"), L("id")], [eld, ft]);
		expect(plan.detector).toBe(ft);
		expect(plan.undetectable).toEqual([]);
		// Without the model, id is reported undetectable (rule 5c keeps it in play).
		expect(planDetector([L("ja"), L("id")], [eld]).undetectable).toEqual([L("id")]);
	});

	test("Indonesian blocks are decided by rule 4 and translated; English is skipped", () => {
		const subset = [L("id"), L("ja")];
		const texts = [
			"Apakah Anda yakin ingin menghapus file ini?",
			"Pembayaran berhasil, pesanan akan segera diproses",
			"Your order has been shipped to the destination address",
			// fastText is weak on short text (GLIM-21: 85%): p 0.48 here, so rule 5 decides, and
			// the capture's confident Indonesian majority carries it (5b).
			"Pesanan Anda sedang dikirim ke alamat tujuan",
		];
		const { detector } = planDetector(subset, [eld, ft]);
		const r = detectCaptureLanguages(blocks(texts), { subset, target: L("en"), detector });
		expect(r.get("b0")).toMatchObject({ rule: "4", translate: true, language: { kind: "language", lang: "id" } });
		expect(r.get("b1")).toMatchObject({ rule: "4", translate: true, language: { kind: "language", lang: "id" } });
		// English is outside the subset: decided and skipped, not translated.
		expect(r.get("b2")).toMatchObject({ rule: "4", translate: false, language: { kind: "skipped", lang: "en" } });
		expect(r.get("b3")).toMatchObject({ rule: "5b", translate: true, language: { kind: "language", lang: "id" } });
	});

	test("rule 4w (GLIM-142): a short block's weak lead goes to the window's language", () => {
		// The Galician settings list reads gl as a whole (0.98); this row alone reads pt 0.79 / gl 0.15.
		const subset = [L("gl"), L("es"), L("pt")];
		const texts = [
			"Notificacións",
			"Idioma e rexión",
			"Buscar actualizacións",
			"Abrir automaticamente ao acender o ordenador",
		];
		const { detector } = planDetector(subset, [eld, ft]);
		expect(detector).toBe(ft);
		const r = detectCaptureLanguages(blocks(texts), { subset, target: L("en"), detector });
		expect(r.get("b3")).toMatchObject({ rule: "4w", translate: true, language: { lang: "gl" } });
		// GLIM-104's starting point (no 4w) translated it as Portuguese.
		const before = detectCaptureLanguages(blocks(texts), { subset, target: L("en"), detector, priorMargin: null });
		expect(before.get("b3")).toMatchObject({ rule: "4", language: { lang: "pt" } });
	});

	test("rule 4w leaves a confident block of another language alone (mixed window)", () => {
		const subset = [L("kk"), L("ru")];
		const texts = ["Кіру", "Телефон нөміріңізді енгізіңіз", "Забыли пароль?", "Продолжить на русском языке"];
		const r = detectCaptureLanguages(blocks(texts), { subset, target: L("en"), detector: ft });
		expect(r.get("b1")).toMatchObject({ rule: "4", language: { lang: "kk" } });
		expect(r.get("b2")).toMatchObject({ rule: "4", language: { lang: "ru" } });
		expect(r.get("b3")).toMatchObject({ rule: "4", language: { lang: "ru" } });
	});

	test("Settings: only languages neither detector covers get the can't-be-detected note", () => {
		const covered = new Set([...eld.languages, ...ft.languages]);
		for (const c of sourceLanguageChoices("en")) {
			if (c.detectedBy === null) continue;
			const lang = c.code.split("-")[0] ?? c.code;
			const known = covered.has(c.code) || [...covered].some((k) => k.split("-")[0] === lang);
			expect({ code: c.code, known }).toEqual({ code: c.code, known: true });
		}
		expect(sourceLanguageChoices("en").find((c) => c.code === L("id"))).toMatchObject({
			detectable: true,
			detectedBy: "fasttext",
		});
	});
});

describe("fastText adapter (fake native)", () => {
	const vector = <T>(items: T[], freed: { n: number }): EmVector<T> => ({
		size: () => items.length,
		get: (i) => items[i] as T,
		delete: () => {
			freed.n++;
		},
	});

	test("maps labels, drops unknown ones, sorts, and frees each prediction's vector", () => {
		const freed = { n: 0 };
		const seen: string[] = [];
		const native: FastTextNative = {
			getLabels: () => [vector(["__label__en", "__label__id", "__label__zh", "__label__!?"], freed)],
			predict: (text) => {
				seen.push(text);
				return vector<readonly [number, string]>(
					text === ""
						? [[0.3, "__label__en"]]
						: [
								[0.2, "__label__en"],
								[0.7, "__label__id"],
								[0.05, "__label__!?"],
							],
					freed,
				);
			},
		};
		const d = new FastTextLanguageDetector(native);
		expect(d.languages).toEqual([L("en"), L("id"), L("zh-Hans"), L("zh-Hant")]);
		const r = d.detect("Halo\n  dunia");
		// The constructor asks once for the model's no-evidence answer (empty text).
		expect(seen).toEqual(["", "Halo dunia"]);
		expect(r.candidates).toEqual([
			{ lang: L("id"), score: 0.7 },
			{ lang: L("en"), score: 0.2 },
		]);
		expect(r.reliable).toBe(true);
		expect(freed.n).toBe(2);
	});

	test("the model's bias-only answer is no evidence, not English (GLIM-145)", () => {
		const freed = { n: 0 };
		const bias: [number, string][] = [
			[0.1245, "__label__en"],
			[0.0859, "__label__ca"],
		];
		const native: FastTextNative = {
			getLabels: () => [vector(["__label__en", "__label__ca", "__label__sw"], freed)],
			predict: (text) =>
				vector<readonly [number, string]>(
					text === "Habari"
						? [
								[0.6, "__label__sw"],
								[0.1, "__label__en"],
							]
						: bias,
					freed,
				),
		};
		const d = new FastTextLanguageDetector(native);
		expect(d.detect("Jumla")).toEqual({ candidates: [], reliable: false, noEvidence: true });
		expect(d.detect("Habari").candidates[0]).toEqual({ lang: L("sw"), score: 0.6 });
		expect(d.detect("Habari").noEvidence).toBeUndefined();
	});
});
