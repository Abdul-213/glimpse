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
// - Scores are softmax probabilities. No rule 4w tuning (GLIM-140's margin is on ELD's scale);
//   rule 4 uses GLIM-21's tau on the probability.
// - `predict` is synchronous once the model is loaded (~0.09 ms per block, GLIM-21).

/// <reference path="./fasttext-wasm.d.ts" />
import { readFile } from "node:fs/promises";
import {
	chineseVariant,
	type DetectorCandidate,
	type DetectorResult,
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
/** `reliable` when the top label's probability reaches this (GLIM-21: "fastText: p >= its threshold"). */
export const FASTTEXT_RELIABLE = 0.5;

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
