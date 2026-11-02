// What the pipeline tells the popups, in the order they render it
// (docs/design/specs/snip-popup.md §4 and §8, live-popup.md L0):
//
//   started                  S0: popup opens with placeholder bars
//   detected                 S1: one skeleton bar and on-screen box per detected text box
//   recognised               S2: blocks with text, language and class (translate / skip /
//                            neutral / target). Authoritative: block grouping may merge the
//                            detected boxes, so the view replaces its skeletons with these.
//   packs                    pack rows for source languages whose pack isn't installed (§2.2)
//   translation (per block)  S3: cache hits first, then provider results in reading order.
//                            Not final: translated sentences so far + remaining source text.
//                            Final: the whole block, or a failure with its kind.
//   progress                 "Translating {done} of {n}" after each final block
//   done                     S4 / S16 / E1-E7: the whole result and its error kind, if any
//
// Every event carries `runId`, so a view can drop events from an older run (a quick
// second Snip, a newer Live frame). All payloads are plain data (RPC-safe).

import type { BlockId, BlockLanguage } from "../block.ts";
import type { Rect } from "../geometry.ts";
import type { LanguageCode } from "../language/code.ts";
import type { TextDirection } from "../language/script.ts";
import type { ProviderErrorInfo } from "../providers/errors.ts";
import type { Provenance, ProviderRef } from "../providers/provenance.ts";
import type { PackRow, SegmentFailureKind } from "../providers/readiness.ts";

/** GLIM-21 classes as the popups name them (snip-popup.md §13.2 `BlockClass`). */
export type BlockClass = "translate" | "skip" | "neutral" | "target";

export interface RecognisedBlock {
	readonly id: BlockId;
	/** Position in reading order, 0-based. */
	readonly order: number;
	/** Region-local device pixels (the captured image's space). */
	readonly box: Rect;
	/** OCR text, lines joined with "\n". */
	readonly text: string;
	readonly confidence: number;
	readonly language: BlockLanguage;
	/** The detected language (also for skipped blocks, when known), else null. */
	readonly lang: LanguageCode | null;
	readonly cls: BlockClass;
	/** Direction of the source text (from `lang`), for the original view. */
	readonly direction: TextDirection;
	/** Translate-class block waiting for a language pack (a pack row lists it). */
	readonly waitingForPack: boolean;
}

export interface BlockFailure {
	readonly kind: SegmentFailureKind;
	readonly error: ProviderErrorInfo;
}

/** One block's translation state. `text` is what the popup shows in the translation slot. */
export interface BlockTranslation {
	readonly blockId: BlockId;
	readonly text: string;
	readonly final: boolean;
	readonly failure: BlockFailure | null;
	readonly from: LanguageCode;
	readonly to: LanguageCode;
	/** Pivot languages used (`[en]` for Bergamot `ja → en → de`). */
	readonly via: readonly LanguageCode[];
	/**
	 * Who produced it (route-level fingerprint). `remembered` when every sentence came from
	 * the cache; a remembered cloud result still says "Sent to {provider}" (GLIM-22).
	 */
	readonly provider: Provenance | null;
}

/** Whole-run states with an error body (snip-popup.md §4 E1-E7, §13.2 `error.kind`). */
export type PipelineErrorKind =
	| "noText"
	| "packMissing"
	| "providerKey"
	| "providerQuota"
	| "spendCap"
	| "providerTimeout"
	| "offline"
	| "screenAccess"
	| "captureBlank"
	| "captureFailed"
	| "nothingToTranslate"
	| "ocrFailed";

export interface PipelineError {
	readonly kind: PipelineErrorKind;
	/** Developer detail (never screen text). */
	readonly message: string;
	readonly error?: ProviderErrorInfo;
}

export interface PipelineResult {
	readonly runId: string;
	readonly mode: "snip" | "live";
	readonly target: LanguageCode;
	readonly blocks: readonly RecognisedBlock[];
	/** Final translations of translate-class blocks, by block id (not for waiting blocks). */
	readonly translations: Readonly<Record<BlockId, BlockTranslation>>;
	readonly packs: readonly PackRow[];
	/** Blocks finished / translate-class blocks that were sent for translation. */
	readonly done: number;
	readonly total: number;
	readonly error: PipelineError | null;
	readonly ocr: Provenance | null;
	/** Distinct providers that produced the shown translations. */
	readonly translators: readonly Provenance[];
	/** Something left the device (cloud OCR or a cloud translation, remembered or not). */
	readonly cloud: boolean;
	readonly private: boolean;
	readonly timings: { readonly ocrMs: number; readonly translateMs: number; readonly totalMs: number };
}

export type PipelineEvent =
	| {
			readonly type: "started";
			readonly runId: string;
			readonly mode: "snip" | "live";
			readonly target: LanguageCode;
			readonly private: boolean;
			/** The OCR provider and the first ready translation provider, for the footer badge. */
			readonly ocr: ProviderRef | null;
			readonly translation: ProviderRef | null;
	  }
	| {
			readonly type: "detected";
			readonly runId: string;
			readonly image: { readonly width: number; readonly height: number };
			readonly boxes: readonly { readonly id: string; readonly box: Rect }[];
	  }
	| { readonly type: "recognised"; readonly runId: string; readonly blocks: readonly RecognisedBlock[] }
	| { readonly type: "packs"; readonly runId: string; readonly rows: readonly PackRow[] }
	| { readonly type: "translation"; readonly runId: string; readonly translation: BlockTranslation }
	| { readonly type: "progress"; readonly runId: string; readonly done: number; readonly total: number }
	| { readonly type: "done"; readonly runId: string; readonly result: PipelineResult };

export type PipelineListener = (event: PipelineEvent) => void;
