// Providers for harness runs (GLIM-102): a scripted OCR provider and the real Bergamot
// provider over packs already installed in a model-manager folder. Nothing here downloads:
// install packs first (GLIMPSE_REAL_PACKS=1 bun test app/test/bergamot-real.test.ts does,
// into ~/.cache/glimpse/test-installs).
import { join } from "node:path";
import { type LanguageCode, type OcrBlock, rect, type TranslationProvider } from "@glimpse/core";
import { FakeOcrProvider, FakeTranslationProvider } from "@glimpse/core/testing";
import { BergamotTranslationProvider } from "@glimpse/providers/translation/bergamot";
import { defaultCacheDir } from "../../scripts/model-cache.ts";
import { loadBergamotCatalogue } from "../bun/services/models/catalogue.ts";
import { ModelManager } from "../bun/services/models/model-manager.ts";
import { ModelManagerPackSource } from "../bun/services/translation/bergamot-packs.ts";

/** Where the real-pack tests install packs (shared with app/test/bergamot-real.test.ts). */
export const defaultPackRoot = (): string => join(defaultCacheDir(), "..", "test-installs");

/**
 * An OCR provider that "reads" the given lines: one block per line, stacked top to bottom
 * inside the image, boxes first (progressive) like PaddleOCR.
 */
export function scriptedOcr(lines: readonly string[], id = "harness-ocr"): FakeOcrProvider {
	return new FakeOcrProvider({
		id,
		name: "Scripted OCR",
		blocks: (req): OcrBlock[] => {
			const h = Math.max(1, Math.floor(req.image.height / Math.max(1, lines.length)));
			return lines.map((text, i) => ({
				id: `b${i + 1}`,
				text,
				box: rect(0, i * h, req.image.width, h),
				confidence: 0.99,
			}));
		},
	});
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
