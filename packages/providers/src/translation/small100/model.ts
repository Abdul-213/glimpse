// What the SMaLL-100 provider needs on disk and which languages it serves (GLIM-100). Pure.
//
// The model is one download (`small100` in app/models/manifest.json): an int8 ONNX encoder, a
// merged KV-cache decoder, and M2M-100's tokenizer.json. Languages are M2M-100's 100 codes
// (core catalogue `m2m` column), any to any, no pivot.
import { allLanguages, type LanguageCode, toM2m } from "@glimpse/core";

/** Model manager id and install folder name. */
export const SMALL100_MODEL_ID = "small100";

export const SMALL100_FILES = {
	encoder: "encoder_model_quantized.onnx",
	decoder: "decoder_model_merged_quantized.onnx",
	tokenizer: "tokenizer.json",
} as const;

/**
 * Languages SMaLL-100 reads (every catalogue language with an M2M-100 code). Several tags share
 * a code: zh-Hans and zh-Hant both read as `zh`, nb as `no`, Dari as `fa`.
 */
export const SMALL100_SOURCES: readonly LanguageCode[] = allLanguages()
	.filter((l) => l.m2m !== undefined)
	.map((l) => l.code);

/**
 * Languages it writes. `zh` output is Simplified Chinese, so zh-Hant isn't a target (it would
 * get the wrong script); the same goes for tags that only borrow a sibling's code.
 */
const NOT_TARGETS: ReadonlySet<string> = new Set(["zh-Hant", "fa-AF"]);
export const SMALL100_TARGETS: readonly LanguageCode[] = SMALL100_SOURCES.filter((c) => !NOT_TARGETS.has(c));

/** The M2M-100 code for `code` as a source / target, or null when SMaLL-100 can't serve it. */
export function small100Code(code: LanguageCode, role: "source" | "target"): string | null {
	if (role === "target" && NOT_TARGETS.has(code)) return null;
	return toM2m(code);
}

/** Where the installed model is, when it is (from the model manager). */
export interface Small100Model {
	readonly dir: string;
	/** Manifest revision, part of every result's fingerprint. */
	readonly revision: string;
}

/**
 * The model's install state, read on every call (a download can land at any time). The
 * provider never downloads: when `installed()` is null it reports the pair as `missing` with
 * `download` (id and size) for the model manager to fetch with the user's consent.
 */
export interface Small100ModelSource {
	installed(): Small100Model | null;
	/** What to download when it isn't installed: model manager id, size and manifest revision. */
	readonly download: { readonly id: string; readonly bytes: number | null; readonly revision: string };
	/** Called when the install state may have changed. Returns an unsubscribe function. */
	subscribe?(listener: () => void): () => void;
}

/** A fixed source, for tests and the bench. */
export function staticSmall100Source(
	model: Small100Model | null,
	download: { readonly bytes: number | null; readonly revision: string } = { bytes: null, revision: "test" },
): Small100ModelSource {
	return { installed: () => model, download: { id: SMALL100_MODEL_ID, ...download } };
}
