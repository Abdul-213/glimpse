import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProviderError, languageCode, type OcrProgress } from "@glimpse/core";
import { type ContractCheck, ocrProviderContract } from "@glimpse/core/testing";
import { folderModelSource } from "../../src/ocr/paddle/model-files.ts";
import { PaddleOcrProvider } from "../../src/ocr/paddle/paddle-provider.ts";
import { cacheSource, FIXTURES, hasBundled, hasRecognizer, manifest, warnIfMissing } from "../helpers/models.ts";
import { loadPng, toPaddedBgra } from "../helpers/png.ts";

warnIfMissing();

const make = () => new PaddleOcrProvider({ threads: 2 }, { models: cacheSource });
const fixture = (name: string) => loadPng(join(FIXTURES, name));
const T = 60_000;
/** Every recognised line, whatever the grouping. */
const linesOf = (r: { blocks: readonly { text: string }[] }) => r.blocks.flatMap((b) => b.text.split("\n"));

describe.skipIf(!hasBundled)("PaddleOCR: core OCR provider contract (real models)", async () => {
	const image = await fixture("region-en.png");
	const checks: ContractCheck[] = ocrProviderContract(make, {
		image,
		expectText: "Settings saved",
		language: languageCode("en"),
	});
	for (const c of checks) test(c.name, c.run, T);
});

describe("PaddleOCR: models missing", () => {
	const empty = folderModelSource(manifest, [mkdtempSync(join(tmpdir(), "glimpse-ocr-empty-"))]);

	test("init reports model-missing with the detector and the bundled recognisers", async () => {
		const p = new PaddleOcrProvider({}, { models: empty });
		const status = await p.init();
		expect(status.state).toBe("model-missing");
		const ids = status.state === "model-missing" ? status.missing.map((m) => m.id).sort() : [];
		expect(ids).toEqual(["ocr-det", "ocr-rec-ch", "ocr-rec-latin"]);
		for (const m of status.state === "model-missing" ? status.missing : []) expect(m.bytes).toBeGreaterThan(0);
		expect(p.languageSupport(languageCode("ja")).status).toBe("unsupported");
		await p.dispose();
	});

	test("recognise before ready rejects not-ready", async () => {
		const p = new PaddleOcrProvider({}, { models: empty });
		await p.init();
		const img = await fixture("region-en.png");
		await expect(p.recognise({ image: img })).rejects.toMatchObject({ code: "not-ready" });
		await p.dispose();
	});
});

describe.skipIf(!hasBundled)("PaddleOCR: real models", () => {
	test(
		"languageSupport: ready, missing (downloadable) and unsupported",
		async () => {
			// Only the bundled set: hide the on-demand recognisers even if the cache has them.
			const bundledOnly = {
				manifest,
				resolve: (m: (typeof manifest.models)[number], f: (typeof manifest.models)[number]["files"][number]) =>
					m.bundled ? cacheSource.resolve(m, f) : null,
			};
			const p = new PaddleOcrProvider({ threads: 1 }, { models: bundledOnly });
			try {
				expect((await p.init()).state).toBe("ready");
				for (const l of ["ja", "zh-Hans", "zh-Hant", "en", "de", "vi", "fr"]) {
					expect(p.languageSupport(languageCode(l)).status).toBe("ready");
				}
				// GLIM-126: Vietnamese loses most tone marks with the latin recogniser.
				expect(p.languageSupport(languageCode("vi"))).toEqual({ status: "ready", partial: true });
				expect(p.languageSupport(languageCode("de"))).toEqual({ status: "ready" });
				const ko = p.languageSupport(languageCode("ko"));
				expect(ko).toMatchObject({ status: "missing", missing: [{ id: "ocr-rec-korean" }] });
				expect(p.languageSupport(languageCode("ru"))).toMatchObject({
					status: "missing",
					missing: [{ id: "ocr-rec-eslav" }],
				});
				expect(p.languageSupport(languageCode("ar"))).toMatchObject({ status: "missing" });
				// PP-OCRv5 has no Hebrew, Georgian or Bengali recogniser.
				for (const l of ["he", "ka", "bn"]) expect(p.languageSupport(languageCode(l)).status).toBe("unsupported");
				// A Korean-only request can't run: the recogniser must be downloaded first.
				const img = await fixture("region-ko.png");
				const err = await p.recognise({ image: img, languages: [languageCode("ko")] }).catch((e: unknown) => e);
				expect(isProviderError(err, "model-missing")).toBe(true);
				const he = await p.recognise({ image: img, languages: [languageCode("he")] }).catch((e: unknown) => e);
				expect(isProviderError(he, "unsupported-language")).toBe(true);
			} finally {
				await p.dispose();
			}
		},
		T,
	);

	test(
		"reads Japanese, Chinese, English and German; progressive events match; BGRA with padded rows",
		async () => {
			const p = make();
			try {
				await p.init();
				await p.warmup();
				const ja = await p.recognise({ image: await fixture("region-ja.png"), languages: [languageCode("ja")] });
				const jaText = linesOf(ja);
				expect(jaText).toContain("設定を保存しました。");
				// The full-width ？ comes back as ASCII "?" from the ch recogniser.
				expect(jaText.map((t) => t.replace("？", "?"))).toContain("このアイテムを使用しますか?");

				const zh = await p.recognise({ image: await fixture("region-zh.png") });
				expect(linesOf(zh)).toContain("请输入您的密码。");

				// German: `ch` reads first, Latin-script lines are re-read by `latin` (umlauts).
				const de = await p.recognise({
					image: toPaddedBgra(await fixture("region-de.png")),
					languages: [languageCode("ja"), languageCode("de")],
				});
				const deText = linesOf(de).join("\n");
				expect(deText).toContain("Möchten Sie die Änderungen übernehmen?");
				expect(deText).toContain("Die Datei konnte nicht gespeichert werden.");

				const events: OcrProgress[] = [];
				const en = await p.recognise({ image: await fixture("region-en.png") }, { onProgress: (e) => events.push(e) });
				expect(events[0]?.type).toBe("detected");
				const progressBlocks = events.flatMap((e) => (e.type === "block" ? [e.block] : []));
				expect(progressBlocks.map((b) => b.id).sort()).toEqual(en.blocks.map((b) => b.id).sort());
				expect(linesOf(en)).toContain("Error 404: file not found");
				// Reading order: top to bottom.
				const ys = en.blocks.map((b) => b.box.y);
				expect([...ys].sort((a, b) => a - b)).toEqual(ys);
			} finally {
				await p.dispose();
			}
		},
		T,
	);

	test(
		"GLIM-56: lines are grouped into blocks (columns, vertical Japanese); grouping: lines keeps one per line",
		async () => {
			const p = make();
			const flat = new PaddleOcrProvider({ threads: 2, grouping: "lines" }, { models: cacheSource });
			try {
				await p.init();
				await flat.init();
				const cols = await p.recognise({ image: await fixture("columns-en.png"), languages: [languageCode("en")] });
				expect(cols.blocks.map((b) => b.text.split("\n").length)).toEqual([1, 3, 3, 1, 1]);
				expect(cols.blocks[1]?.lines).toHaveLength(3);
				const vert = await p.recognise({ image: await fixture("vertical-ja.png"), languages: [languageCode("ja")] });
				expect(vert.blocks.map((b) => [b.writing, b.text])).toEqual([
					["vertical-rl", "吾輩は猫である\n名前はまだ無い\nどこで生れたか"],
				]);
				const lines = await flat.recognise({ image: await fixture("columns-en.png"), languages: [languageCode("en")] });
				expect(lines.blocks).toHaveLength(9);
				expect(lines.blocks.every((b) => !b.text.includes("\n"))).toBe(true);
			} finally {
				await p.dispose();
				await flat.dispose();
			}
		},
		T,
	);

	test(
		"cancelling mid-request rejects cancelled promptly and the provider keeps working",
		async () => {
			const p = make();
			try {
				await p.init();
				const screen = await fixture("screen-1920x1080.png");
				const controller = new AbortController();
				const pending = p.recognise({ image: screen }, { signal: controller.signal });
				setTimeout(() => controller.abort(), 30);
				const started = performance.now();
				const err = await pending.catch((e: unknown) => e);
				expect(isProviderError(err, "cancelled")).toBe(true);
				expect(performance.now() - started).toBeLessThan(500);
				const after = await p.recognise({ image: await fixture("region-en.png") });
				expect(after.blocks.length).toBeGreaterThan(0);
			} finally {
				await p.dispose();
			}
		},
		T,
	);

	test(
		"GLIM-88: an unchanged frame is served from the rec cache",
		async () => {
			const p = make();
			try {
				await p.init();
				const img = await fixture("region-en.png");
				const first = await p.recognise({ image: img });
				expect(p.lastTimings?.cacheHits).toBe(0);
				const again = await p.recognise({ image: img });
				expect(p.lastTimings?.recRuns).toBe(0);
				// Every line read by every recogniser the first frame used (ch, then latin for Latin text).
				expect(p.lastTimings?.cacheHits).toBeGreaterThanOrEqual(first.blocks.length);
				expect(again.blocks.map((b) => b.text)).toEqual(first.blocks.map((b) => b.text));
				await p.clearCache();
				await p.recognise({ image: img });
				expect(p.lastTimings?.recRuns).toBeGreaterThan(0);
			} finally {
				await p.dispose();
			}
		},
		T,
	);
});

describe.skipIf(!hasRecognizer("arabic"))("PaddleOCR: Arabic (on-demand model)", () => {
	test(
		"Arabic comes out in logical order",
		async () => {
			const p = make();
			try {
				await p.init();
				const ar = await p.recognise({ image: await fixture("region-ar.png"), languages: [languageCode("ar")] });
				const text = linesOf(ar);
				expect(text).toContain("اكتمل التنزيل");
				expect(text.some((t) => t.startsWith("هل تريد"))).toBe(true);
			} finally {
				await p.dispose();
			}
		},
		T,
	);
});

describe.skipIf(!hasRecognizer("korean"))("PaddleOCR: Korean (on-demand model)", () => {
	test(
		"Korean routes to the korean recogniser",
		async () => {
			const p = make();
			try {
				await p.init();
				const ko = await p.recognise({
					image: await fixture("region-ko.png"),
					languages: [languageCode("ja"), languageCode("ko")],
				});
				expect(linesOf(ko)).toContain("설정이 저장되었습니다.");
			} finally {
				await p.dispose();
			}
		},
		T,
	);
});
