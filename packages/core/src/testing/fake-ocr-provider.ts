// A scripted in-memory OcrProvider for tests in every package.
//
//   const ocr = new FakeOcrProvider({ blocks: [ocrBlock("b1", "こんにちは", rect(0, 0, 80, 20))] });
//   await ocr.init();
//   const { blocks } = await ocr.recognise({ image: blankImage(200, 100) });

import type { OcrBlock } from "../block.ts";
import { intersection, type Rect, rect } from "../geometry.ts";
import { abortable, ProviderError, type ProviderErrorCode, throwIfAborted } from "../providers/errors.ts";
import { type ProviderStatus, StatusCell, type Unsubscribe } from "../providers/lifecycle.ts";
import {
	type OcrCapabilities,
	type OcrImage,
	type OcrOptions,
	type OcrProvider,
	type OcrRequest,
	type OcrResult,
	validateOcrImage,
} from "../providers/ocr.ts";
import { type ProviderFingerprint, type ProviderInfo, provenanceOf, stableHash } from "../providers/provenance.ts";

export interface FakeOcrOptions {
	readonly id?: string;
	readonly name?: string;
	readonly kind?: "local" | "cloud";
	readonly capabilities?: Partial<OcrCapabilities>;
	/** What every call returns, or a function of the request. Default: one block. */
	readonly blocks?: readonly OcrBlock[] | ((request: OcrRequest) => readonly OcrBlock[]);
	/** Throw a ProviderError with this code for the request. */
	readonly fail?: (request: OcrRequest) => ProviderErrorCode | null;
	/** Awaited before recognising. Hold it open to test cancellation. */
	readonly gate?: (request: OcrRequest, signal: AbortSignal | undefined) => Promise<void>;
	readonly initStatus?: ProviderStatus | (() => ProviderStatus | Promise<ProviderStatus>);
	readonly modelRevision?: string;
	readonly options?: Readonly<Record<string, unknown>>;
}

export const ocrBlock = (id: string, text: string, box: Rect, confidence = 0.9): OcrBlock => ({
	id,
	text,
	box,
	confidence,
});

/** A blank image of the given size, for tests that don't care about pixels. */
export function blankImage(width: number, height: number, format: OcrImage["format"] = "bgra8"): OcrImage {
	const bpp = format === "gray8" ? 1 : 4;
	return { width, height, stride: width * bpp, format, data: new Uint8Array(width * height * bpp) };
}

export class FakeOcrProvider implements OcrProvider {
	readonly info: ProviderInfo & { readonly task: "ocr" };
	readonly capabilities: OcrCapabilities;
	readonly calls: OcrRequest[] = [];
	initCalls = 0;

	readonly #cell = new StatusCell();
	readonly #opts: FakeOcrOptions;
	#initPromise: Promise<ProviderStatus> | null = null;

	constructor(options: FakeOcrOptions = {}) {
		this.#opts = options;
		const kind = options.kind ?? "local";
		this.info = {
			id: options.id ?? "fake-ocr",
			name: options.name ?? "Fake OCR",
			kind,
			task: "ocr",
			vendor: kind === "cloud" ? "Fake Cloud Inc." : null,
		};
		this.capabilities = {
			kind,
			needsNetwork: kind === "cloud",
			secretId: kind === "cloud" ? "fake-cloud" : null,
			languages: "any",
			progressive: true,
			regions: true,
			maxImagePixels: null,
			maxImageBytes: null,
			...options.capabilities,
		};
	}

	get status(): ProviderStatus {
		return this.#cell.status;
	}

	onStatusChange(listener: (status: ProviderStatus) => void): Unsubscribe {
		return this.#cell.subscribe(listener);
	}

	setStatus(status: ProviderStatus): void {
		this.#cell.set(status);
	}

	init(signal?: AbortSignal): Promise<ProviderStatus> {
		throwIfAborted(signal, this.info.id);
		const state = this.#cell.status.state;
		if (state === "ready" || state === "disposed") return Promise.resolve(this.#cell.status);
		if (!this.#initPromise) {
			this.initCalls++;
			this.#cell.set({ state: "loading" });
			const initStatus = this.#opts.initStatus ?? { state: "ready" };
			this.#initPromise = Promise.resolve(typeof initStatus === "function" ? initStatus() : initStatus).then(
				(status) => {
					this.#initPromise = null;
					this.#cell.set(status);
					return this.#cell.status;
				},
			);
		}
		return abortable(this.#initPromise, signal, this.info.id);
	}

	async dispose(): Promise<void> {
		this.#cell.set({ state: "disposed" });
		this.#cell.clear();
	}

	fingerprint(): ProviderFingerprint {
		return {
			providerId: this.info.id,
			modelRevision: this.#opts.modelRevision ?? "fake-ocr-1",
			optionsHash: stableHash(this.#opts.options ?? {}),
		};
	}

	async recognise(request: OcrRequest, options: OcrOptions = {}): Promise<OcrResult> {
		const { signal, onProgress } = options;
		const id = this.info.id;
		throwIfAborted(signal, id);
		if (this.#cell.status.state !== "ready") {
			throw new ProviderError("not-ready", `provider is ${this.#cell.status.state}`, { providerId: id });
		}
		const bad = validateOcrImage(request.image);
		if (bad) throw new ProviderError("invalid-request", bad, { providerId: id });
		const max = this.capabilities.maxImagePixels;
		if (max !== null && request.image.width * request.image.height > max) {
			throw new ProviderError("input-too-large", `image over ${max} px`, { providerId: id });
		}
		this.calls.push(request);
		const failure = this.#opts.fail?.(request) ?? null;
		if (failure) throw new ProviderError(failure, "scripted failure", { providerId: id });
		if (this.#opts.gate) await abortable(this.#opts.gate(request, signal), signal, id);
		throwIfAborted(signal, id);

		const scripted = this.#opts.blocks ?? [
			ocrBlock("b1", "Hello", rect(0, 0, Math.min(40, request.image.width), Math.min(12, request.image.height))),
		];
		let blocks = [...(typeof scripted === "function" ? scripted(request) : scripted)];
		const { regions } = request;
		if (this.capabilities.regions && regions && regions.length > 0) {
			blocks = blocks.filter((b) => regions.some((r) => intersection(r, b.box) !== null));
		}
		if (this.capabilities.progressive && onProgress) {
			onProgress({ type: "detected", boxes: blocks.map((b) => b.box) });
			for (const block of blocks) {
				throwIfAborted(signal, id);
				onProgress({ type: "block", block });
			}
		}
		return { blocks, provider: provenanceOf(this.info, this.fingerprint()) };
	}
}
