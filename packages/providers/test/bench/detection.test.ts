// GLIM-142: the detection calibration benchmark (bench/detection): its scoring, its corpus, and
// a floor under the shipped fastText tuning with the real lid.176 model.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { languageCode, planDetector } from "@glimpse/core";
import { FakeLanguageDetector } from "@glimpse/core/testing";
import { DETECTION_CORPUS } from "../../bench/detection/corpus.ts";
import { bucketOf, expectedAction, pct, retuned, scoreAlone, scoreRules } from "../../bench/detection/score.ts";
import { loadEldDetector } from "../../src/language-detect/eld.ts";
import { FASTTEXT_TUNING, loadFastTextDetector } from "../../src/language-detect/fasttext.ts";

const L = languageCode;

describe("scoring", () => {
	test("length buckets follow rule 4's 8 and rule 4w's 24 letters", () => {
		expect(bucketOf("Batal")).toBe("short");
		expect(bucketOf("Bahasa dan wilayah")).toBe("medium");
		expect(bucketOf("Buka otomatis saat komputer dinyalakan")).toBe("long");
	});

	test("expected action: translate subset languages, keep the target, skip the rest", () => {
		expect(expectedAction(L("id"), [L("id"), L("en")])).toBe("translate");
		expect(expectedAction(L("en"), [L("id"), L("en")])).toBe("keep");
		expect(expectedAction(L("en"), [L("id")])).toBe("skip");
	});

	test("a wrong source counts as wrong; retuned recomputes reliability from tau", () => {
		const corpus = [
			{ id: "c", kind: "ui" as const, sources: ["id", "ms"], blocks: [{ lang: "id", text: "Pengaturan umum" }] },
		];
		const fake = new FakeLanguageDetector({ "Pengaturan umum": [["ms", 0.45]] }, { languages: ["id", "ms"] });
		expect(scoreAlone(corpus, fake).all).toEqual({ correct: 0, total: 1 });
		// tau 0.5: unreliable, rule 5c translates the top subset candidate (ms): wrong source.
		const s = scoreRules(corpus, retuned(fake, { tau: 0.5 }));
		expect(s).toMatchObject({ wrongSource: 1, missed: 0 });
		expect(retuned(fake, { tau: 0.4 }).detect("Pengaturan umum").reliable).toBe(true);
		expect(retuned(fake, { tau: 0.5 }).detect("Pengaturan umum").reliable).toBe(false);
	});
});

const SHA = "8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83";
const cache = process.env["GLIMPSE_MODEL_CACHE"] ?? join(process.env["HOME"] ?? "", ".cache", "glimpse", "models");
const fromCache = join(cache, "sha256", SHA);
const fromPackage = join(
	import.meta.dir,
	"../../node_modules/fasttext.wasm.js/dist/models/language-identification/assets/lid.176.ftz",
);

describe("fastText calibration (real lid.176)", async () => {
	const ft = await loadFastTextDetector({ modelPath: existsSync(fromCache) ? fromCache : fromPackage });
	const eld = await loadEldDetector();

	test("every capture's subset makes planDetector pick fastText", () => {
		for (const c of DETECTION_CORPUS) {
			expect({ id: c.id, detector: planDetector(c.sources.map(L), [eld, ft]).detector?.id }).toEqual({
				id: c.id,
				detector: ft.id,
			});
		}
	});

	test("the shipped tuning beats GLIM-104's starting point and stays above its measured floor", () => {
		const before = scoreRules(DETECTION_CORPUS, retuned(ft, { tau: 0.5 }));
		const after = scoreRules(DETECTION_CORPUS, ft);
		const viaRetuned = scoreRules(DETECTION_CORPUS, retuned(ft, FASTTEXT_TUNING));
		expect(after.all).toEqual(viaRetuned.all);
		// docs/benchmarks/language-detection.md: 136 -> 144 of 190.
		expect(after.all.correct).toBeGreaterThan(before.all.correct);
		expect(pct(after.all)).toBeGreaterThanOrEqual(0.75);
		expect(after.missed).toBeLessThanOrEqual(before.missed);
	});
});
