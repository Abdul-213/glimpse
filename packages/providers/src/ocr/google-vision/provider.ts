// GLIM-60: Google Cloud Vision as an OCR provider (cloud, opt-in; GLIM-22).
//
// `POST https://vision.googleapis.com/v1/images:annotate` with the shared Google Cloud key
// (`x-goog-api-key`), one image per call: the selected region only, re-encoded as a lossless
// PNG with no metadata. Feature choice (`feature: "auto"`): DOCUMENT_TEXT_DETECTION, which
// detects every language and reports confidences, unless the user's source subset is small
// enough to pass as `languageHints` (<= 3 languages), when TEXT_DETECTION (tuned for sparse
// text in images, which is what screens mostly hold) is enough.
//
// - `init()` only checks that a key is saved (no network): `ready` or `needs-key`.
// - Every result carries cloud provenance (`kind: "cloud"`, vendor Google) for the
//   indicator and the cache. Vision's per-block `detectedLanguages` become `languageHints`.
// - Never called unless the user picked it for OCR (the registry never selects a cloud
//   provider by default); no fallback to or from it happens here.

import {
	abortable,
	fromGoogle,
	type LanguageCode,
	type OcrCapabilities,
	type OcrLanguageSupport,
	type OcrOptions,
	type OcrProvider,
	type OcrRequest,
	type OcrResult,
	PROVIDER_IDS,
	ProviderError,
	type ProviderFingerprint,
	type ProviderInfo,
	type ProviderStatus,
	provenanceOf,
	SecretStoreError,
	StatusCell,
	stableHash,
	throwIfAborted,
	toGoogle,
	type Unsubscribe,
	validateOcrImage,
} from "@glimpse/core";
import {
	callGoogle,
	type FetchLike,
	GOOGLE_SECRET_ID,
	type GoogleCloudContext,
	GoogleError,
	type GoogleProblem,
	readGoogleKey,
} from "../../google/common.ts";
import { parseVisionResponse, responseError, type VisionUnit } from "./parse.ts";
import { encodePng, toBase64 } from "./png.ts";

export const VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";

export const GOOGLE_VISION_INFO: ProviderInfo & { readonly task: "ocr" } = {
	id: PROVIDER_IDS.googleVision,
	name: "Google Cloud Vision",
	kind: "cloud",
	task: "ocr",
	vendor: "Google",
};

/** Vision's documented limits: 20 MB per image, 10 MB per JSON request (base64 adds 1/3). */
export const VISION_MAX_IMAGE_BYTES = 7_000_000;
/** Larger than any single display today (a 6K panel is ~20 MP); callers downscale beyond it. */
export const VISION_MAX_IMAGE_PIXELS = 40_000_000;
/** Pass the source subset as `languageHints` only when it is this small (GLIM-22). */
export const MAX_LANGUAGE_HINTS = 3;

export const GOOGLE_VISION_CAPABILITIES: OcrCapabilities = {
	kind: "cloud",
	needsNetwork: true,
	secretId: GOOGLE_SECRET_ID,
	languages: "any",
	progressive: false,
	regions: false,
	maxImagePixels: VISION_MAX_IMAGE_PIXELS,
	maxImageBytes: VISION_MAX_IMAGE_BYTES,
};

export type VisionFeature = "auto" | "text" | "document";

export interface GoogleVisionOptions {
	readonly feature: VisionFeature;
	/** One OcrBlock per Vision block (default) or per paragraph. */
	readonly unit: VisionUnit;
	/** Per-request timeout (snip-popup.md: 10 s for cloud calls). */
	readonly timeoutMs: number;
}

export const GOOGLE_VISION_DEFAULTS: GoogleVisionOptions = { feature: "auto", unit: "block", timeoutMs: 10_000 };

/** Vision has no model version in its replies; bump this when the request shape changes. */
export const VISION_MODEL_REVISION = "vision-v1:builtin-stable";

/** The feature for a request: DOCUMENT_TEXT_DETECTION unless a small hint list makes TEXT enough. */
export function visionFeatureFor(feature: VisionFeature, hints: readonly string[]): string {
	if (feature === "text") return "TEXT_DETECTION";
	if (feature === "document") return "DOCUMENT_TEXT_DETECTION";
	return hints.length > 0 ? "TEXT_DETECTION" : "DOCUMENT_TEXT_DETECTION";
}

/** The subset as Vision `languageHints`, or [] when it is empty or too large to help. */
export function visionHints(languages: readonly LanguageCode[] | undefined): string[] {
	if (!languages || languages.length === 0 || languages.length > MAX_LANGUAGE_HINTS) return [];
	const codes = languages.map((l) => toGoogle(l)).filter((c): c is string => c !== null);
	return [...new Set(codes)];
}

/** `google.rpc.Code` of a per-image error -> our problem. */
function rpcProblem(code: number): GoogleProblem {
	switch (code) {
		case 3: // INVALID_ARGUMENT: bad image data, image too large
			return "bad-request";
		case 4: // DEADLINE_EXCEEDED
			return "timeout";
		case 7: // PERMISSION_DENIED
			return "permission-denied";
		case 8: // RESOURCE_EXHAUSTED
			return "quota-exceeded";
		case 16: // UNAUTHENTICATED
			return "key-invalid";
		default:
			return "server";
	}
}

export class GoogleVisionProvider implements OcrProvider {
	readonly info = GOOGLE_VISION_INFO;
	readonly capabilities = GOOGLE_VISION_CAPABILITIES;
	readonly options: GoogleVisionOptions;

	readonly #ctx: GoogleCloudContext["google"];
	readonly #fetch: FetchLike;
	readonly #cell = new StatusCell();
	readonly #fingerprint: ProviderFingerprint;
	#initPromise: Promise<ProviderStatus> | null = null;

	constructor(options: Partial<GoogleVisionOptions>, ctx: GoogleCloudContext) {
		this.options = { ...GOOGLE_VISION_DEFAULTS, ...options };
		this.#ctx = ctx.google;
		this.#fetch = ctx.google.fetch ?? ((url, init) => fetch(url, init));
		this.#fingerprint = {
			providerId: this.info.id,
			modelRevision: VISION_MODEL_REVISION,
			optionsHash: stableHash({ feature: this.options.feature, unit: this.options.unit }),
		};
	}

	get status(): ProviderStatus {
		return this.#cell.status;
	}

	onStatusChange(listener: (status: ProviderStatus) => void): Unsubscribe {
		return this.#cell.subscribe(listener);
	}

	/** Checks that a key is saved; no network. Call again after the key changes. */
	init(signal?: AbortSignal): Promise<ProviderStatus> {
		throwIfAborted(signal, this.info.id);
		const state = this.#cell.status.state;
		if (state === "ready" || state === "disposed") return Promise.resolve(this.#cell.status);
		if (!this.#initPromise) {
			this.#cell.set({ state: "loading" });
			this.#initPromise = this.#checkKey().then((status) => {
				this.#initPromise = null;
				this.#cell.set(status);
				return this.#cell.status;
			});
		}
		return abortable(this.#initPromise, signal, this.info.id);
	}

	async #checkKey(): Promise<ProviderStatus> {
		try {
			return (await this.#ctx.secrets.has(GOOGLE_SECRET_ID)) ? { state: "ready" } : { state: "needs-key" };
		} catch (error) {
			const kind = error instanceof SecretStoreError ? error.kind : "unknown";
			const info = new ProviderError("needs-key", `keychain unavailable: ${kind}`, { providerId: this.info.id });
			return { state: "error", error: info.toInfo() };
		}
	}

	async dispose(): Promise<void> {
		this.#cell.set({ state: "disposed" });
		this.#cell.clear();
	}

	fingerprint(): ProviderFingerprint {
		return this.#fingerprint;
	}

	languageSupport(lang: LanguageCode): OcrLanguageSupport {
		if (this.#cell.status.state !== "ready") return { status: "unsupported" };
		return toGoogle(lang) !== null ? { status: "ready" } : { status: "unsupported" };
	}

	async recognise(request: OcrRequest, options: OcrOptions = {}): Promise<OcrResult> {
		const { signal } = options;
		const id = this.info.id;
		throwIfAborted(signal, id);
		const state = this.#cell.status.state;
		if (state === "needs-key")
			throw new GoogleError("no-key", "vision", "no Google Cloud API key saved", { providerId: id });
		if (state !== "ready") throw new ProviderError("not-ready", `provider is ${state}`, { providerId: id });
		const { image } = request;
		const bad = validateOcrImage(image);
		if (bad) throw new ProviderError("invalid-request", bad, { providerId: id });
		if (image.width * image.height > VISION_MAX_IMAGE_PIXELS) {
			throw new ProviderError("input-too-large", `image is ${image.width}x${image.height}`, { providerId: id });
		}

		let key: string;
		try {
			key = await readGoogleKey(this.#ctx.secrets, "vision", id, signal);
		} catch (error) {
			if (error instanceof GoogleError && error.problem === "no-key") this.#cell.set({ state: "needs-key" });
			throw error;
		}
		const png = encodePng(image);
		if (png.byteLength > VISION_MAX_IMAGE_BYTES) {
			throw new ProviderError("input-too-large", `encoded image is ${png.byteLength} bytes`, { providerId: id });
		}
		throwIfAborted(signal, id);
		const hints = visionHints(request.languages);
		const body = {
			requests: [
				{
					image: { content: toBase64(png) },
					features: [{ type: visionFeatureFor(this.options.feature, hints) }],
					...(hints.length > 0 ? { imageContext: { languageHints: hints } } : {}),
				},
			],
		};
		const json = await callGoogle({
			providerId: id,
			api: "vision",
			fetch: this.#fetch,
			key,
			url: VISION_ENDPOINT,
			body,
			signal,
			timeoutMs: this.options.timeoutMs,
		});
		throwIfAborted(signal, id);
		const responses = (json as { responses?: unknown }).responses;
		const first = Array.isArray(responses) ? responses[0] : undefined;
		if (first === undefined) {
			throw new GoogleError("server", "vision", "Cloud Vision returned no response for the image", { providerId: id });
		}
		const failed = responseError(first);
		if (failed) {
			throw new GoogleError(
				rpcProblem(failed.code),
				"vision",
				`Cloud Vision image error ${failed.code}: ${failed.message}`,
				{
					providerId: id,
				},
			);
		}
		const blocks = parseVisionResponse(first, {
			width: image.width,
			height: image.height,
			unit: this.options.unit,
			fromGoogle,
		});
		return { blocks, provider: provenanceOf(this.info, this.#fingerprint) };
	}
}
