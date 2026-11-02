// GLIM-32: the OCR provider contract. Image in, text blocks with boxes and confidence out.
//
// Implementations: PaddleOCR via ONNX Runtime (local default), Google Cloud Vision
// (cloud opt-in, GLIM-22). They live in `packages/providers`; core only defines the shape.
// Contract tests every implementation must pass: `ocrProviderContract` in
// `@glimpse/core/testing`.

import type { OcrBlock } from "../block.ts";
import type { Rect } from "../geometry.ts";
import type { LanguageCode } from "../language.ts";
import type { ModelResource, ProviderLifecycle } from "./lifecycle.ts";
import type { Provenance, ProviderFingerprint, ProviderInfo, ProviderKind } from "./provenance.ts";

/**
 * Raw pixels of one captured region, as capture backends produce them. Device pixels,
 * origin at the region's top-left; OCR boxes come back in the same space.
 */
export interface OcrImage {
	readonly width: number;
	readonly height: number;
	/** Bytes per row (>= width * bytes per pixel; capture backends often pad rows). */
	readonly stride: number;
	/** `bgra8` is what DXGI and ScreenCaptureKit hand over; `gray8` for pre-processed input. */
	readonly format: "rgba8" | "bgra8" | "gray8";
	readonly data: Uint8Array;
}

export const bytesPerPixel = (format: OcrImage["format"]): number => (format === "gray8" ? 1 : 4);

export interface OcrRequest {
	readonly image: OcrImage;
	/**
	 * The user's source-language subset, as hints. Engines that take language hints (Vision
	 * `languageHints`) use them; others ignore them. Empty or absent means "any language".
	 */
	readonly languages?: readonly LanguageCode[];
	/**
	 * Only recognise text inside these rectangles (image space). Live mode passes the areas
	 * whose pixels changed (GLIM-20 OCR reuse). Ignored unless `capabilities.regions`.
	 */
	readonly regions?: readonly Rect[];
}

/** Progressive OCR events for Snip: boxes first, then each block as it is recognised. */
export type OcrProgress =
	| { readonly type: "detected"; readonly boxes: readonly Rect[] }
	| { readonly type: "block"; readonly block: OcrBlock };

export interface OcrOptions {
	readonly signal?: AbortSignal;
	/** Called only by providers with `capabilities.progressive`. Must not throw. */
	readonly onProgress?: (event: OcrProgress) => void;
}

export interface OcrResult {
	/** In reading order. Ids unique within the result. Boxes inside the image. */
	readonly blocks: readonly OcrBlock[];
	readonly provider: Provenance;
}

export interface OcrCapabilities {
	readonly kind: ProviderKind;
	/** True for cloud providers and anything else that fails offline. */
	readonly needsNetwork: boolean;
	/**
	 * Keychain entry this provider needs (`google-cloud` is shared by Vision and Translation
	 * v2, GLIM-22), or null. Keys are read through the SecretStore port, never settings.
	 */
	readonly secretId: string | null;
	/** Languages it can read, or `any` for script-agnostic engines. Informational for UI. */
	readonly languages: readonly LanguageCode[] | "any";
	/** Emits `onProgress` events. */
	readonly progressive: boolean;
	/** Honours `OcrRequest.regions`. */
	readonly regions: boolean;
	/** Largest image it accepts (width * height), or null for no limit. Callers downscale. */
	readonly maxImagePixels: number | null;
	/** Largest encoded upload in bytes (cloud), or null. */
	readonly maxImageBytes: number | null;
}

/**
 * Whether a provider can read one language right now. PP-OCRv5 uses one recognition model
 * per script family (GLIM-17 findings: ch/ja, Korean, Latin, Cyrillic, Arabic, ...), so a
 * ready provider can still lack the model for a language in the user's subset.
 */
export type OcrLanguageSupport =
	/** `partial`: read, but part of the alphabet is lost (Vietnamese tone marks, GLIM-126). */
	| { readonly status: "ready"; readonly partial?: true }
	| { readonly status: "missing"; readonly missing: readonly ModelResource[] }
	| { readonly status: "unsupported" };

export interface OcrProvider extends ProviderLifecycle {
	readonly info: ProviderInfo & { readonly task: "ocr" };
	readonly capabilities: OcrCapabilities;
	/** Identity for caches. Stable while the provider is ready; may change after `init()`. */
	fingerprint(): ProviderFingerprint;
	/**
	 * Per-language readiness, answered from state loaded by `init()`. Onboarding and Settings
	 * use it to offer the right model downloads for the source subset (GLIM-57).
	 * `unsupported` before init.
	 */
	languageSupport(lang: LanguageCode): OcrLanguageSupport;
	/**
	 * Recognise text. Rejects with `ProviderError`:
	 * `cancelled` (signal), `not-ready`, `model-missing`, `input-too-large`, `invalid-request`
	 * (bad image geometry), and for cloud `needs-key` / `invalid-key` / `offline` / `network`
	 * / `rate-limited` / `quota-exceeded` / `timeout`.
	 */
	recognise(request: OcrRequest, options?: OcrOptions): Promise<OcrResult>;
}

/** `invalid-request` reason for a malformed image, or null when it is fine. */
export function validateOcrImage(image: OcrImage): string | null {
	const { width, height, stride, data, format } = image;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		return `image size must be positive integers, got ${width}x${height}`;
	}
	const minStride = width * bytesPerPixel(format);
	if (!Number.isInteger(stride) || stride < minStride) return `stride ${stride} < ${minStride}`;
	const needed = stride * (height - 1) + minStride;
	if (data.byteLength < needed) return `image data is ${data.byteLength} bytes, needs ${needed}`;
	return null;
}
