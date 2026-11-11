// Unit tests for the pure OCR pieces: pixels, DB post-process, CTC, RTL fix-up, recogniser
// planning, the rec cache and the engine's routing (with fake ORT sessions).
import { describe, expect, test } from "bun:test";
import { languageCode, type OcrRecognizer } from "@glimpse/core";
import { convexHull, dbPostprocess, detInputSize, minAreaRect, rectCorners, unclip } from "../../src/ocr/paddle/det.ts";
import { CancelledError, OcrEngine, type OrtSession, type OrtTensor } from "../../src/ocr/paddle/engine.ts";
import { type Raster, rasterOf, resizeNormalizeBGR, rgbaRaster, rotate90ccw } from "../../src/ocr/paddle/image.ts";
import { explainOrtLoadFailure, VC_REDIST_URL } from "../../src/ocr/paddle/load-failure.ts";
import { quadBounds } from "../../src/ocr/paddle/paddle-provider.ts";
import { buildCharset, ctcDecode, recWidth, visualToLogicalRtl } from "../../src/ocr/paddle/rec.ts";
import { fnvCropHash, RecCache } from "../../src/ocr/paddle/rec-cache.ts";
import {
	lookalikeReaderFor,
	looksLikeLookalikes,
	planRecognizers,
	preferLookalike,
	specialistFor,
} from "../../src/ocr/paddle/recognizers.ts";

const L = languageCode;

describe("image", () => {
	test("BGRA with padded rows normalises exactly like RGBA", () => {
		const w = 5;
		const h = 3;
		const rgba = new Uint8Array(w * h * 4).map((_, i) => (i * 37) % 256);
		const stride = w * 4 + 8;
		const bgra = new Uint8Array(stride * h);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const s = (y * w + x) * 4;
				const d = y * stride + x * 4;
				bgra.set([rgba[s + 2] ?? 0, rgba[s + 1] ?? 0, rgba[s] ?? 0, 255], d);
			}
		const a = resizeNormalizeBGR(
			rasterOf({ width: w, height: h, stride: w * 4, format: "rgba8", data: rgba }),
			8,
			4,
			[0.5, 0.5, 0.5],
			[0.5, 0.5, 0.5],
		);
		const b = resizeNormalizeBGR(
			rasterOf({ width: w, height: h, stride, format: "bgra8", data: bgra }),
			8,
			4,
			[0.5, 0.5, 0.5],
			[0.5, 0.5, 0.5],
		);
		expect([...b]).toEqual([...a]);
	});

	test("gray8 feeds the same value to all three channels", () => {
		const img = rasterOf({ width: 2, height: 1, stride: 2, format: "gray8", data: new Uint8Array([0, 255]) });
		const t = resizeNormalizeBGR(img, 2, 1, [0, 0, 0], [1, 1, 1]);
		expect([...t]).toEqual([0, 1, 0, 1, 0, 1]);
	});

	test("rotate90ccw moves the top-right pixel to the top-left", () => {
		const img = rgbaRaster(2, 1, new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2]));
		const r = rotate90ccw(img);
		expect([r.width, r.height]).toEqual([1, 2]);
		expect(r.data[0]).toBe(2);
		expect(r.data[4]).toBe(1);
	});
});

describe("det", () => {
	test("input size rounds to multiples of 32 and respects the caps", () => {
		expect(detInputSize(600, 200, { maxSide: 1920, minSide: 0 })).toMatchObject({ w: 608, h: 192 });
		expect(detInputSize(3840, 2160, { maxSide: 1920, minSide: 0 })).toMatchObject({ w: 1920, h: 1088 });
		expect(detInputSize(100, 20, { maxSide: 1920, minSide: 64 })).toMatchObject({ w: 320, h: 64 });
	});

	test("hull, min-area rect and unclip of an axis-aligned rectangle", () => {
		const pts = [
			[0, 0],
			[10, 0],
			[10, 4],
			[0, 4],
			[5, 2],
		] as const;
		const hull = convexHull(pts);
		expect(hull).toHaveLength(4);
		const r = minAreaRect(hull);
		expect(Math.round(r.w * r.h)).toBe(40);
		const u = unclip(r, 1.5);
		const d = (40 * 1.5) / 28;
		expect(Math.min(u.w, u.h)).toBeCloseTo(4 + 2 * d, 5);
		const q = rectCorners(r);
		expect(q[0][0]).toBeCloseTo(0, 5);
		expect(q[0][1]).toBeCloseTo(0, 5);
		expect(q[2][0]).toBeCloseTo(10, 5);
	});

	test("DB post-process finds two lines in a synthetic probability map, top first", () => {
		const mw = 64;
		const mh = 32;
		const prob = new Float32Array(mw * mh);
		const fill = (x0: number, y0: number, x1: number, y1: number) => {
			for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) prob[y * mw + x] = 0.9;
		};
		fill(30, 20, 60, 26);
		fill(4, 4, 40, 10);
		const boxes = dbPostprocess(prob, mw, mh, 128, 64);
		expect(boxes).toHaveLength(2);
		const [a, b] = boxes.map((bx) => quadBounds(bx.quad, 128, 64));
		expect(a?.y).toBeLessThan(b?.y ?? 0);
		// Map pixels scale by 2 into the source, plus the unclip margin.
		expect(a?.x).toBeLessThanOrEqual(8);
		expect((a?.x ?? 0) + (a?.width ?? 0)).toBeGreaterThanOrEqual(80);
	});

	test("noise below the box threshold is dropped", () => {
		const prob = new Float32Array(32 * 32).fill(0.31);
		expect(dbPostprocess(prob, 32, 32, 32, 32)).toHaveLength(0);
	});
});

describe("rec", () => {
	test("charset: blank first, space last", () => {
		expect(buildCharset("a\nb\n")).toEqual(["", "a", "b", " "]);
	});

	test("greedy CTC collapses repeats and drops blanks", () => {
		const cs = ["", "a", "b", " "];
		const steps = [1, 1, 0, 1, 2, 2, 3, 0];
		const probs = new Float32Array(steps.length * 4);
		steps.forEach((c, t) => {
			probs[t * 4 + c] = 0.9;
		});
		const r = ctcDecode(probs, steps.length, 4, cs);
		expect(r.text).toBe("aab ");
		expect(r.score).toBeCloseTo(0.9, 5);
	});

	test("RTL visual order becomes logical; LTR runs keep their order", () => {
		expect(visualToLogicalRtl("لزنتلا")).toBe("التنزل");
		// "USB C" in visual order stays "USB C"; the Arabic around it reverses.
		expect(visualToLogicalRtl("ب USB C أ")).toBe("أ USB C ب");
		expect(visualToLogicalRtl("100% ءزج")).toBe("جزء 100%");
	});

	test("rec width follows the aspect ratio at height 48, capped", () => {
		expect(recWidth(200, 24, 3200)).toBe(400);
		expect(recWidth(10000, 10, 3200)).toBe(3200);
	});
});

describe("recogniser planning", () => {
	const all = new Set<OcrRecognizer>(["ch", "latin", "korean", "arabic", "eslav", "cyrillic"]);
	const bundled = new Set<OcrRecognizer>(["ch", "latin"]);

	test("{ja, en} needs only ch; {de} only latin; {ja, de} ch first then latin", () => {
		expect(planRecognizers([L("ja"), L("en")], bundled)).toEqual(["ch"]);
		expect(planRecognizers([L("en"), L("ja")], bundled)).toEqual(["ch"]);
		expect(planRecognizers([L("de")], bundled)).toEqual(["latin"]);
		expect(planRecognizers([L("de"), L("ja")], bundled)).toEqual(["ch", "latin"]);
	});

	test("missing and unsupported languages drop out", () => {
		expect(planRecognizers([L("ko")], bundled)).toEqual([]);
		expect(planRecognizers([L("ko"), L("ja")], bundled)).toEqual(["ch"]);
		expect(planRecognizers([L("he")], all)).toEqual([]);
		expect(planRecognizers([L("ru"), L("ko"), L("ar")], all)).toEqual(["eslav", "korean", "arabic"]);
	});

	test("GLIM-125: without CJK, English doesn't pull in ch and Cyrillic/Greek readers go first", () => {
		const wide = new Set<OcrRecognizer>([...all, "en", "el"]);
		expect(planRecognizers([L("ru"), L("uk"), L("bg"), L("en")], wide)).toEqual(["eslav", "en"]);
		expect(planRecognizers([L("en"), L("ru")], wide)).toEqual(["eslav", "en"]);
		expect(planRecognizers([L("ru"), L("en")], all)).toEqual(["eslav", "latin"]);
		expect(planRecognizers([L("el"), L("en")], wide)).toEqual(["el", "en"]);
		expect(planRecognizers([L("de"), L("ru")], wide)).toEqual(["eslav", "latin"]);
		expect(planRecognizers([L("ar"), L("en")], wide)).toEqual(["arabic", "en"]);
		// CJK in the subset: ch still covers English and reads first.
		expect(planRecognizers([L("ja"), L("ru"), L("en")], wide)).toEqual(["ch", "eslav"]);
		expect(planRecognizers([L("ja"), L("ko"), L("zh-Hans"), L("en")], wide)).toEqual(["ch", "korean"]);
	});

	test("no languages: the defaults that are installed", () => {
		expect(planRecognizers(undefined, all)).toEqual(["ch", "latin"]);
		expect(planRecognizers([], new Set<OcrRecognizer>(["korean"]))).toEqual(["korean"]);
	});

	test("specialists: Latin text from ch goes to latin, Hangul to korean, Han never leaves ch", () => {
		expect(specialistFor("Möchten Sie", "ch", ["ch", "latin"])).toBe("latin");
		expect(specialistFor("Hello", "ch", ["ch"])).toBeNull();
		expect(specialistFor("설정", "ch", ["ch", "korean"])).toBe("korean");
		expect(specialistFor("設定を保存", "ch", ["ch", "latin"])).toBeNull();
		expect(specialistFor("設定を保存", "latin", ["latin", "ch"])).toBe("ch");
		expect(specialistFor("12:30", "ch", ["ch", "latin"])).toBeNull();
	});

	test("look-alikes: misread Cyrillic and Greek are flagged, ordinary English is not", () => {
		// What ch actually produced for the GLIM-64 Cyrillic/Greek frames.
		for (const t of [
			"CoxpaHnTb N3MeHeHng?",
			"Ecnn 3akpbiTb AoKyMeHT ceiuaC, Bce HecoxpaHëHHble",
			"OTMeHa",
			"HoB npo3opeu",
			"M3xOA",
			"OTBapaHe Ha φaǔn",
			"Aπo0ńkeuon aλλayiv;",
			"OTMEHA",
			"∩PMMEHNTb",
		])
			expect(looksLikeLookalikes(t)).toBe(true);
		for (const t of [
			"Save changes to this document?",
			"If you close it now, the edits you made since the last",
			"Sprache und Region",
			"Cancel",
			"Open file",
			"It's 12:30 on the 2nd of May, 2026.",
			"A",
		])
			expect(looksLikeLookalikes(t)).toBe(false);
	});

	test("look-alike reader: Cyrillic or Greek candidate, Greek letters pick el", () => {
		expect(lookalikeReaderFor("CoxpaHnTb", "ch", ["ch", "eslav"])).toBe("eslav");
		expect(lookalikeReaderFor("CoxpaHnTb", "ch", ["ch", "latin"])).toBeNull();
		expect(lookalikeReaderFor("Cancel", "ch", ["ch", "eslav"])).toBeNull();
		expect(lookalikeReaderFor("CoxpaHnTb", "eslav", ["eslav", "en"])).toBeNull();
		expect(lookalikeReaderFor("Aπo0ńkeuon aλλayiv;", "ch", ["ch", "eslav", "el"])).toBe("el");
		expect(lookalikeReaderFor("CoxpaHnTb", "ch", ["ch", "el", "cyrillic"])).toBe("cyrillic");
	});

	test("look-alike re-read wins only in its own script and at a similar score", () => {
		const first = { text: "CoxpaHnTb", score: 0.92, recognizer: "ch" as const };
		expect(preferLookalike(first, { text: "Сохранить", score: 0.99, recognizer: "eslav" }).text).toBe("Сохранить");
		expect(preferLookalike(first, { text: "Сохранить", score: 0.7, recognizer: "eslav" }).text).toBe("CoxpaHnTb");
		expect(preferLookalike(first, { text: "iPhone", score: 0.99, recognizer: "eslav" }).text).toBe("CoxpaHnTb");
	});
});

describe("rec cache", () => {
	test("LRU eviction and per-recogniser keys", () => {
		const c = new RecCache(2);
		c.set("ch", "a", { text: "A", score: 1 });
		c.set("ch", "b", { text: "B", score: 1 });
		expect(c.get("ch", "a")?.text).toBe("A");
		c.set("ch", "c", { text: "C", score: 1 });
		expect(c.get("ch", "b")).toBeUndefined();
		expect(c.get("ch", "a")?.text).toBe("A");
		expect(c.get("latin", "a")).toBeUndefined();
		expect(new RecCache(0).get("ch", "a")).toBeUndefined();
	});

	test("crop hash depends on pixels and size", () => {
		const a = rgbaRaster(4, 2, new Uint8Array(32).fill(7));
		const b = rgbaRaster(4, 2, new Uint8Array(32).fill(7));
		const c = rgbaRaster(2, 4, new Uint8Array(32).fill(7));
		const d = rgbaRaster(4, 2, new Uint8Array(32).fill(7));
		d.data[5] = 8;
		expect(fnvCropHash(a)).toBe(fnvCropHash(b));
		expect(fnvCropHash(a)).not.toBe(fnvCropHash(c));
		expect(fnvCropHash(a)).not.toBe(fnvCropHash(d));
	});
});

// ---- engine routing with fake sessions -------------------------------------------------

/** A recogniser that "reads" every crop as `text` with `score`; counts calls. */
function fakeRec(charset: string[], text: string, score: number): OrtSession & { runs: number; items: number } {
	const s = {
		runs: 0,
		items: 0,
		inputNames: ["x"],
		outputNames: ["y"],
		async run(feeds: Record<string, OrtTensor>) {
			const n = feeds["x"]?.dims[0] ?? 1;
			s.runs++;
			s.items += n;
			const C = charset.length;
			const T = text.length * 2;
			const probs = new Float32Array(n * T * C);
			for (let i = 0; i < n; i++)
				[...text].forEach((ch, k) => {
					probs[i * T * C + 2 * k * C + charset.indexOf(ch)] = score;
					probs[i * T * C + (2 * k + 1) * C] = score; // blank between characters
				});
			return { y: { data: probs, dims: [n, T, C] } };
		},
	};
	return s;
}

/** A detector whose probability map has two horizontal bars. */
const fakeDet: OrtSession = {
	inputNames: ["x"],
	outputNames: ["y"],
	async run(feeds) {
		const [, , h = 32, w = 32] = feeds["x"]?.dims ?? [];
		const prob = new Float32Array(w * h);
		for (const y0 of [4, 18]) for (let y = y0; y < y0 + 6; y++) for (let x = 2; x < w - 2; x++) prob[y * w + x] = 0.9;
		return { y: { data: prob, dims: [1, 1, h, w] } };
	},
};

const tensor = (data: Float32Array, dims: readonly number[]): OrtTensor => ({ data, dims });
const image = (seed: number): Raster => rgbaRaster(64, 32, new Uint8Array(64 * 32 * 4).fill(seed));

describe("engine", () => {
	const charset = buildCharset(["H", "i", "ö", "設", "定"].join("\n"));

	test("Latin text from ch is re-read by latin; the specialist wins", async () => {
		const ch = fakeRec(charset, "Hi", 0.97);
		const latin = fakeRec(charset, "Hö", 0.99);
		const e = new OcrEngine(tensor, fakeDet);
		e.addRecognizer("ch", ch, charset);
		e.addRecognizer("latin", latin, charset);
		const img = image(1);
		const boxes = await e.detect(img);
		expect(boxes).toHaveLength(2);
		const lines = await e.recognize(img, boxes, ["ch", "latin"]);
		expect(lines.map((l) => [l.text, l.recognizer])).toEqual([
			["Hö", "latin"],
			["Hö", "latin"],
		]);
		expect(ch.items).toBe(2);
		expect(latin.items).toBe(2);
	});

	test("Han text stays with ch; low scores try the other candidates", async () => {
		const ch = fakeRec(charset, "設定", 0.6);
		const latin = fakeRec(charset, "Hi", 0.9);
		const e = new OcrEngine(tensor, fakeDet);
		e.addRecognizer("ch", ch, charset);
		e.addRecognizer("latin", latin, charset);
		const img = image(2);
		const lines = await e.recognize(img, await e.detect(img), ["ch", "latin"]);
		// 0.6 < FALLBACK_SCORE, so latin also reads; its 0.9 wins.
		expect(lines.map((l) => l.text)).toEqual(["Hi", "Hi"]);
	});

	test("GLIM-125: Latin look-alikes from ch are re-read by eslav; Cyrillic needs no further pass", async () => {
		const cs = buildCharset(
			["C", "o", "x", "p", "a", "H", "n", "T", "b", "С", "о", "х", "р", "а", "н", "и", "т", "ь"].join("\n"),
		);
		const ch = fakeRec(cs, "CoxpaHnTb", 0.92);
		const eslav = fakeRec(cs, "Сохранить", 0.99);
		const e = new OcrEngine(tensor, fakeDet);
		e.addRecognizer("ch", ch, cs);
		e.addRecognizer("eslav", eslav, cs);
		const img = image(6);
		const lines = await e.recognize(img, await e.detect(img), ["ch", "eslav"]);
		expect(lines.map((l) => [l.text, l.recognizer])).toEqual([
			["Сохранить", "eslav"],
			["Сохранить", "eslav"],
		]);
		expect(eslav.items).toBe(2);
	});

	test("identical crops hit the cache; cancellation is checked between runs", async () => {
		const ch = fakeRec(charset, "設定", 0.95);
		const e = new OcrEngine(tensor, fakeDet, { recBatch: 1 });
		e.addRecognizer("ch", ch, charset);
		const img = image(3);
		const boxes = await e.detect(img);
		await e.recognize(img, boxes, ["ch"]);
		const runs = ch.runs;
		const lines = await e.recognize(img, boxes, ["ch"]);
		expect(ch.runs).toBe(runs);
		expect(lines).toHaveLength(2);
		const other = image(4);
		await expect(e.recognize(other, boxes, ["ch"], { cancelled: () => true })).rejects.toBeInstanceOf(CancelledError);
	});

	test("lines under minTextScore are dropped; progress sees each kept line once", async () => {
		const ch = fakeRec(charset, "設定", 0.3);
		const e = new OcrEngine(tensor, fakeDet);
		e.addRecognizer("ch", ch, charset);
		const img = image(5);
		const seen: number[] = [];
		const lines = await e.recognize(img, await e.detect(img), ["ch"], { onLine: (i) => seen.push(i) });
		expect(lines).toHaveLength(0);
		expect(seen).toHaveLength(0);
		const ok = new OcrEngine(tensor, fakeDet);
		ok.addRecognizer("ch", fakeRec(charset, "設定", 0.9), charset);
		const kept = await ok.recognize(img, await ok.detect(img), ["ch"], { onLine: (i) => seen.push(i) });
		expect(seen.sort()).toEqual(kept.map((l) => l.index).sort());
	});
});

describe("onnxruntime load failures (GLIM-111)", () => {
	test("a missing-DLL error gets the Visual C++ runtime hint; other errors are unchanged", () => {
		const win =
			"The specified module could not be found.\r\nC:\\Glimpse\\native\\onnxruntime\\onnxruntime_binding.node";
		expect(explainOrtLoadFailure(win)).toContain(win);
		expect(explainOrtLoadFailure(win)).toContain(VC_REDIST_URL);
		expect(explainOrtLoadFailure("bad model file")).toBe("bad model file");
	});
});
