// The provider registry and the context provider factories get (GLIM-43, GLIM-101, GLIM-103).
// Every implementation in @glimpse/providers registers here; the composition root builds the
// context from app services. No Electrobun imports: tested on Linux.
//
// Cloud providers (GLIM-60 Google Cloud Vision, GLIM-61 Google Cloud Translation v2) are registered too, but registering never
// selects them: they have no default rank, and the registry drops a cloud translator listed
// after a local one. They run only after the user picks them in Settings › Providers.
import type { Logger, ProviderRegistry, SecretStore } from "@glimpse/core";
import type { FetchLike, GoogleCloudContext } from "@glimpse/providers/google";
import { googleVisionFactory } from "@glimpse/providers/ocr/google-vision";
import { type PaddleOcrContext, paddleOcrFactory } from "@glimpse/providers/ocr/paddle";
import { type BergamotContext, bergamotFactory, type EngineEvent } from "@glimpse/providers/translation/bergamot";
import { googleTranslateFactory } from "@glimpse/providers/translation/google-v2";
import { paddleModelSource } from "./ocr/paddle-models.ts";
import { ocrSpawner } from "./ocr/paddle-worker.ts";
import type { ModelManagerPackSource } from "./translation/bergamot-packs.ts";
import { bergamotSpawner } from "./translation/bergamot-worker.ts";

/** What provider factories may use. Grows with each provider (cloud: fetch, secrets). */
export type AppProviderContext = BergamotContext & PaddleOcrContext & GoogleCloudContext;

export function registerProviders(registry: ProviderRegistry<AppProviderContext>): void {
	registry.register(paddleOcrFactory<AppProviderContext>());
	registry.register(bergamotFactory<AppProviderContext>());
	registry.register(googleVisionFactory<AppProviderContext>());
	registry.register(googleTranslateFactory<AppProviderContext>());
}

export interface ProviderContextOptions {
	readonly packs: ModelManagerPackSource;
	/** Model folders (bundled + downloaded) for PaddleOCR's files: the model manager. */
	readonly models: { modelDir(id: string): string | null };
	/** Directory of the main bundle (`import.meta.dir` of src/bun/index.ts). */
	readonly mainDir: string;
	readonly warmPairs: NonNullable<BergamotContext["bergamot"]["warmPairs"]>;
	readonly log: Logger;
	readonly env?: Record<string, string | undefined>;
	/** The OS keychain (GLIM-40): cloud providers read their API key through it. */
	readonly secrets: SecretStore;
	/** Default: the global `fetch` (tests pass a fake). */
	readonly fetch?: FetchLike;
}

export function providerContext(options: ProviderContextOptions): {
	readonly ctx: AppProviderContext;
	readonly bergamotWorker: string | null;
	readonly ocrWorker: string | null;
} {
	const { spawn, path } = bergamotSpawner(options.mainDir, options.env);
	const ocr = ocrSpawner(options.mainDir, options.env);
	const log = options.log.child("bergamot");
	const onEvent = (event: EngineEvent) => {
		if (event.type === "worker-stopped" && event.reason === "crash") log.warn("worker crashed");
		else log.debug(event.type, { ...event });
	};
	return {
		ctx: {
			bergamot: {
				packs: options.packs,
				onEvent,
				warmPairs: options.warmPairs,
				...(spawn ? { spawn } : {}),
			},
			models: paddleModelSource(options.models),
			...(ocr.spawn ? { spawnWorker: ocr.spawn } : {}),
			google: { secrets: options.secrets, ...(options.fetch ? { fetch: options.fetch } : {}) },
		},
		bergamotWorker: path,
		ocrWorker: ocr.path,
	};
}
