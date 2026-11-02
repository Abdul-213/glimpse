// GLIM-104: fastText `lid.176.ftz` (176 languages) behind core's `LanguageDetector` port, for
// source subsets with a language ELD lacks (id, sw, uz, ...; GLIM-21). `planDetector` picks it
// only when ELD can't cover the subset.
//
// - The model is CC-BY-SA-3.0, so it is never bundled: an on-demand download in
//   app/models/manifest.json (`fasttext-lid176`) with its attribution, loaded from the path the
//   model manager gives. The runtime is fasttext.wasm.js (MIT; fastText itself MIT) as WASM,
//   so nothing native to build or sign. Only its WASM loader and model class are imported; the
//   package's own copy of the model is never loaded.
// - Labels (`__label__xx`, Wikipedia codes) map to BCP-47 through core's catalogue (`fasttext`
//   scheme). `zh` has no script, so Simplified vs Traditional is chosen by character, like ELD.
// - Scores are softmax probabilities, so its thresholds are its own (`FASTTEXT_TUNING`,
//   calibrated in GLIM-142 on bench/detection; GLIM-140's ELD margin means nothing here).
// - `predict` is synchronous once the model is loaded (~0.09 ms per block, GLIM-21).

/// <reference path="./fasttext-wasm.d.ts" />
import { readFile } from "node:fs/promises";
import {
	chineseVariant,
	type DetectorCandidate,
	type DetectorResult,
	type DetectorTuning,
	fromScheme,
	type LanguageCode,
	type LanguageDetector,
} from "@glimpse/core";

/** Manifest id of the model (app/models/manifest.json). */
export const FASTTEXT_MODEL_ID = "fasttext-lid176";
/** The model file inside its model directory. */
export const FASTTEXT_MODEL_FILE = "lid.176.ftz";

/** How many labels a detection asks for (rule 5c looks at the top 3). */
const TOP_K = 5;
/**
 * Thresholds calibrated on fastText's probabilities (GLIM-142, `bun run bench:lid`: 190 blocks
 * in 37 captures of id, sw, uz, af, gl, mk, kk, mn, ne, ps windows; numbers and method in
 * docs/benchmarks/language-detection.md).
 *
 * - tau 0.5: the best of 0.1-0.8. Lower lets noisy short labels through rule 4 (0.4: -5
 *   blocks without rule 4w, -1 with it), higher sends good ones to rule 5 (0.6: -7).
 * - Rule 4w, margin 0.7 under 48 letters: a block under 48 letters takes the capture's script
 *   prior when its own top-1 leads the prior's language by 0.7 or less. On softmax scores a
 *   short block rarely says more than "somewhere near here" (gl "Abrir automaticamente ao
 *   acender o ordenador": pt 0.79 / gl 0.15; ne "तिमी अहिले कहाँ छौ?": hi 0.67 / ne 0.22), while
 *   the joined window reads clearly (that gl settings list: gl 0.98). 71.6% -> 75.8% of blocks
 *   right. Margins of 0.9 and up start overriding confident
 *   blocks of another language in mixed windows (kk "Телефон нөміріңізді енгізіңіз" at 0.94).
 */
export const FASTTEXT_TUNING = { tau: 0.5, priorMargin: 0.7, priorMaxLetters: 48 } as const satisfies DetectorTuning;
/** `reliable` when the top label's probability reaches rule 4's tau (GLIM-21: "fastText: p >= its threshold"). */
export const FASTTEXT_RELIABLE: number = FASTTEXT_TUNING.tau;

/** The slice of fasttext.wasm.js's native model we use (an emscripten-bound fastText). */
export interface FastTextNative {
	/** Top `k` labels with probabilities >= `threshold`: `get(i)` is `[probability, "__label__xx"]`. */
	predict(text: string, k: number, threshold: number): EmVector<readonly [number, string]>;
	/** `[labels, counts]` (a JS pair of vectors in fasttext.wasm.js 1.0). */
	getLabels(): unknown;
}

/** An emscripten `std::vector` binding. `delete()` frees it on the WASM heap. */
export interface EmVector<T> {
	size(): number;
	get(i: number): T;
	delete?(): void;
}

const strip = (label: string) => label.replace(/^__label__/, "");

const toCode = (label: string, text: string): LanguageCode | null => {
	const hint = label === "zh" ? (chineseVariant(text) ?? "Hans") : undefined;
	return fromScheme("fasttext", label, hint);
};

/** fastText reads one line; OCR blocks can hold several. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export class FastTextLanguageDetector implements LanguageDetector {
	readonly id = "fasttext-lid176";
	readonly tuning: DetectorTuning = FASTTEXT_TUNING;
	readonly languages: readonly LanguageCode[];
	readonly #ft: FastTextNative;

	constructor(ft: FastTextNative) {
		this.#ft = ft;
		this.languages = FastTextLanguageDetector.#languages(ft);
	}

	static #languages(ft: FastTextNative): LanguageCode[] {
		const pair = ft.getLabels() as { 0?: EmVector<string>; get?: (i: number) => EmVector<string> } | null;
		const words = pair?.[0] ?? pair?.get?.(0);
		const codes: LanguageCode[] = [];
		for (let i = 0; i < (words?.size() ?? 0); i++) {
			const label = strip(String(words?.get(i)));
			const found =
				label === "zh"
					? [fromScheme("fasttext", label, "Hans"), fromScheme("fasttext", label, "Hant")]
					: [fromScheme("fasttext", label)];
			for (const c of found) if (c && !codes.includes(c)) codes.push(c);
		}
		return codes;
	}

	detect(text: string): DetectorResult {
		const line = oneLine(text);
		if (line === "") return { candidates: [], reliable: false };
		const v = this.#ft.predict(line, TOP_K, 0);
		const candidates: DetectorCandidate[] = [];
		try {
			for (let i = 0; i < v.size(); i++) {
				const [p, label] = v.get(i);
				const lang = toCode(strip(label), line);
				if (lang && !candidates.some((c) => c.lang === lang)) candidates.push({ lang, score: clamp(p) });
			}
		} finally {
			v.delete?.();
		}
		candidates.sort((a, b) => b.score - a.score);
		return { candidates, reliable: (candidates[0]?.score ?? 0) >= FASTTEXT_RELIABLE };
	}
}

const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

export interface LoadFastTextOptions {
	/** The `lid.176.ftz` file (the model manager's download). */
	readonly modelPath: string;
	/**
	 * `fastText.node.wasm`. Default: next to fasttext.wasm.js's loader in node_modules (dev,
	 * tests); the app passes the copy staged next to its bundle.
	 */
	readonly wasmPath?: string;
}

/** Instantiate the WASM runtime, load the model from disk and wrap it. */
export async function loadFastTextDetector(options: LoadFastTextOptions): Promise<FastTextLanguageDetector> {
	const bytes = new Uint8Array(await readFile(options.modelPath));
	// Typed loosely in fasttext-wasm.d.ts; `FastTextModule` is the part of the emscripten module we use.
	const { getFastTextModule } = await import("fasttext.wasm.js/dist/helpers/modules/node.mjs");
	const mod = (await getFastTextModule(options.wasmPath ? { wasmPath: options.wasmPath } : {})) as FastTextModule;
	const ft = new mod.FastText();
	const inWasm = "/glimpse-lid.176.ftz";
	mod.FS.writeFile(inWasm, bytes);
	ft.loadModel(inWasm);
	mod.FS.unlink?.(inWasm);
	return new FastTextLanguageDetector(ft);
}

interface FastTextModule {
	FastText: new () => FastTextNative & { loadModel(path: string): void };
	FS: { writeFile(path: string, data: Uint8Array): void; unlink?(path: string): void };
}
