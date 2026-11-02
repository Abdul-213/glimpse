// Messages between the PaddleOCR provider (pipeline side) and its inference Worker. Plain data
// only (structured clone); image bytes travel as a transferred ArrayBuffer.

import type { OcrImage, OcrPurpose, OcrRecognizer } from "@glimpse/core";
import type { EngineLine, EngineOptions, EngineTimings } from "./engine.ts";
import type { Quad } from "./image.ts";

export interface WireImage {
	readonly width: number;
	readonly height: number;
	readonly stride: number;
	readonly format: OcrImage["format"];
	readonly data: ArrayBuffer;
}

/** ORT intra-op threads, and whether they busy-wait between ops (GLIM-134). */
export interface OrtProfile {
	readonly threads: number;
	readonly spinning: boolean;
}

export type ToWorker =
	| {
			readonly type: "init";
			readonly id: number;
			readonly det: string;
			/** ORT settings for Snip-like requests (`purpose: "snip"`, the default). */
			readonly snip: OrtProfile;
			/** ORT settings for Live requests: a second set of sessions, made on first use (GLIM-134). */
			readonly live: OrtProfile;
			readonly engine: Partial<EngineOptions>;
	  }
	| {
			readonly type: "load";
			readonly id: number;
			readonly recognizer: OcrRecognizer;
			readonly model: string;
			readonly dict: string;
	  }
	| {
			readonly type: "ocr";
			readonly id: number;
			readonly image: WireImage;
			readonly candidates: readonly OcrRecognizer[];
			readonly progressive: boolean;
			readonly purpose: OcrPurpose;
	  }
	| { readonly type: "warmup"; readonly id: number }
	| { readonly type: "cancel"; readonly id: number; readonly target: number }
	| { readonly type: "clear-cache"; readonly id: number }
	| { readonly type: "dispose"; readonly id: number };

export interface OcrJobResult {
	readonly lines: readonly EngineLine[];
	readonly timings: EngineTimings;
}

export type FromWorker =
	| { readonly type: "ok"; readonly id: number; readonly value?: OcrJobResult }
	| { readonly type: "error"; readonly id: number; readonly name: string; readonly message: string }
	| { readonly type: "detected"; readonly id: number; readonly quads: readonly Quad[] }
	| { readonly type: "line"; readonly id: number; readonly index: number; readonly line: EngineLine };

/** Distributes `Omit` over the union, so `request()` callers don't pass ids. */
export type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
