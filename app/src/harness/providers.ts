// Providers for harness runs (GLIM-102, GLIM-109): a scripted OCR provider, real PaddleOCR over
// the dev model cache (`bun run models`), and the real Bergamot provider over packs already
// installed in a model-manager folder. Nothing here downloads:
// install packs first (GLIMPSE_REAL_PACKS=1 bun test app/test/bergamot-real.test.ts does,
// into ~/.cache/glimpse/test-installs).
import { join } from "node:path";
import {
	frameKey,
	type LanguageCode,
	type OcrBlock,
	type OcrProvider,
	rect,
	type TranslationProvider,
} from "@glimpse/core";
import { FakeOcrProvider, FakeTranslationProvider } from "@glimpse/core/testing";
import { cacheModelSource, type PaddleOcrOptions, PaddleOcrProvider } from "@glimpse/providers/ocr/paddle";
import { BergamotTranslationProvider } from "@glimpse/providers/translation/bergamot";
import { defaultCacheDir, loadManifest } from "../../scripts/model-cache.ts";
import { loadBergamotCatalogue } from "../bun/services/models/catalogue.ts";
import { ModelManager } from "../bun/services/models/model-manager.ts";
import { ModelManagerPackSource } from "../bun/services/translation/bergamot-packs.ts";

/** Where the real-pack tests install packs (shared with app/test/bergamot-real.test.ts). */
export const defaultPackRoot = (): string => join(defaultCacheDir(), "..", "test-installs");

/**
 * An OCR provider that "reads" the given lines: one line per entry, stacked top to bottom
 * inside the image with a line's height between them (so the GLIM-56 grouper keeps them as
 * separate blocks), boxes first (progressive) like PaddleOCR.
 */
export function scriptedOcr(lines: readonly string[], id = "harness-ocr"): FakeOcrProvider {
	return new FakeOcrProvider({
		id,
		name: "Scripted OCR",
		blocks: (req): OcrBlock[] => {
			const slot = Math.max(2, Math.floor(req.image.height / Math.max(1, lines.length)));
			const h = Math.floor(slot / 2);
			return lines.map((text, i) => ({
				id: `b${i + 1}`,
				text,
				box: rect(0, i * slot, req.image.width, h),
				confidence: 0.99,
			}));
		},
	});
}

/**
 * An OCR provider whose output follows the pixels without reading them (GLIM-58 harness):
 * the first distinct image it is shown "reads" as `lines[0]`, the second as `lines[1]`, and
 * so on; an image it has seen before reads the same again. One block covering the image.
 */
export function frameKeyedOcr(lines: readonly string[], id = "harness-frame-ocr"): FakeOcrProvider {
	const seen = new Map<string, string>();
	return new FakeOcrProvider({
		id,
		name: "Frame-keyed OCR",
		blocks: (req): OcrBlock[] => {
			const key = frameKey(req.image);
			let text = seen.get(key);
			if (text === undefined) {
				text = lines[seen.size % Math.max(1, lines.length)] ?? "";
				seen.set(key, text);
			}
			return text ? [{ id: "b1", text, box: rect(0, 0, req.image.width, req.image.height), confidence: 0.99 }] : [];
		},
	});
}

/**
 * An OCR provider for burned-in subtitles (GLIM-114 harness): the subtitle is the only pure
 * white in the moving-video recording, so its box is the white pixels' bounding box and its
 * identity their mask. The first distinct mask reads as `lines[0]`, the next as `lines[1]`...;
 * no white, no text. Unlike `frameKeyedOcr`, a different video frame behind the same subtitle
 * reads the same, and the block has the subtitle's real box (text focus watches it).
 */
export function subtitleOcr(lines: readonly string[], id = "harness-subtitle-ocr"): FakeOcrProvider {
	const seen = new Map<string, string>();
	return new FakeOcrProvider({
		id,
		name: "Subtitle OCR",
		blocks: (req): OcrBlock[] => {
			const { width, height, stride, data } = req.image;
			let minX = width;
			let minY = height;
			let maxX = -1;
			let maxY = -1;
			let hash = 0x811c9dc5;
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const o = y * stride + x * 4;
					if ((data[o] ?? 0) < 250 || (data[o + 1] ?? 0) < 250 || (data[o + 2] ?? 0) < 250) continue;
					hash = Math.imul(hash ^ (y * width + x), 0x01000193) >>> 0;
					if (x < minX) minX = x;
					if (x > maxX) maxX = x;
					if (y < minY) minY = y;
					if (y > maxY) maxY = y;
				}
			}
			if (maxX < 0) return [];
			const key = hash.toString(16);
			let text = seen.get(key);
			if (text === undefined) {
				text = lines[seen.size % Math.max(1, lines.length)] ?? "";
				seen.set(key, text);
			}
			return [{ id: "b1", text, box: rect(minX, minY, maxX + 1 - minX, maxY + 1 - minY), confidence: 0.99 }];
		},
	});
}

/**
 * Real PaddleOCR (GLIM-46) over the dev model cache (`bun run models`), in its Worker, loaded
 * and warmed. Throws when the models aren't there.
 */
export async function paddleOcr(
	cacheDir = defaultCacheDir(),
	options: Partial<PaddleOcrOptions> = {},
): Promise<OcrProvider> {
	const provider = new PaddleOcrProvider(options, { models: cacheModelSource(loadManifest(), cacheDir) });
	const status = await provider.init();
	if (status.state !== "ready") {
		await provider.dispose();
		throw new Error(`PaddleOCR is ${status.state} with models in ${cacheDir} (run: bun run models)`);
	}
	await provider.warmup?.();
	return provider;
}

export interface HarnessTranslator {
	readonly provider: TranslationProvider;
	/** Release Workers and listeners. */
	dispose(): Promise<void>;
}

/** The fake translator (`text [ja>en]`), with the Bergamot-style English pivot. */
export async function fakeTranslator(): Promise<HarnessTranslator> {
	const provider = new FakeTranslationProvider({ id: "fake-translation", pivot: "en" });
	await provider.init();
	return { provider, dispose: () => provider.dispose() };
}

/**
 * Real Bergamot over the packs installed under `root`, in its real Worker. Offline: the
 * catalogue (only needed for download offers) comes from the cached copy, if any.
 */
export async function bergamotTranslator(
	root = defaultPackRoot(),
	warmPairs: readonly { from: LanguageCode; to: LanguageCode }[] = [],
): Promise<HarnessTranslator> {
	const manager = new ModelManager({ root });
	await manager.scan();
	const packs = new ModelManagerPackSource(manager);
	try {
		const catalogue = await loadBergamotCatalogue({
			cacheFile: join(root, ".catalogue.json"),
			fetch: () => Promise.reject(new Error("harness: offline")),
		});
		packs.setCatalogue(catalogue.packs);
	} catch {
		// No cached catalogue: installed packs still translate; missing ones just can't be offered.
	}
	const provider = new BergamotTranslationProvider({ packs, idleMs: 0, warmPairs });
	const status = await provider.init();
	if (status.state !== "ready") {
		await provider.dispose();
		packs.dispose();
		throw new Error(`Bergamot is ${status.state} with packs in ${root} (install them first)`);
	}
	await provider.warmup();
	return {
		provider,
		dispose: async () => {
			await provider.dispose();
			packs.dispose();
		},
	};
}
