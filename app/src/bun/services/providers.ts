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
import {
	type Small100Context,
	type Small100EngineEvent,
	small100Factory,
	staticSmall100Source,
} from "@glimpse/providers/translation/small100";
import { paddleModelSource } from "./ocr/paddle-models.ts";
import { ocrSpawner } from "./ocr/paddle-worker.ts";
import type { ModelManagerPackSource } from "./translation/bergamot-packs.ts";
import { bergamotSpawner } from "./translation/bergamot-worker.ts";
import { type Small100Models, small100ModelSource } from "./translation/small100-model.ts";
import { small100Spawner } from "./translation/small100-worker.ts";

/** What provider factories may use. Grows with each provider (cloud: fetch, secrets). */
export type AppProviderContext = BergamotContext & PaddleOcrContext & GoogleCloudContext & Small100Context;

export function registerProviders(registry: ProviderRegistry<AppProviderContext>): void {
	registry.register(paddleOcrFactory<AppProviderContext>());
	registry.register(bergamotFactory<AppProviderContext>());
	// GLIM-100: second in the default chain, only for pairs Bergamot can't serve (longTail).
	registry.register(small100Factory<AppProviderContext>());
	registry.register(googleVisionFactory<AppProviderContext>());
	registry.register(googleTranslateFactory<AppProviderContext>());
}

export interface ProviderContextOptions {
	readonly packs: ModelManagerPackSource;
	/** Model folders (bundled + downloaded) for PaddleOCR's and SMaLL-100's files: the model manager. */
	readonly models: Small100Models;
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
	readonly small100Worker: string | null;
} {
	const { spawn, path } = bergamotSpawner(options.mainDir, options.env);
	const ocr = ocrSpawner(options.mainDir, options.env);
	const small = small100Spawner(options.mainDir, options.env);
	const smallLog = options.log.child("small100");
	const onSmallEvent = (event: Small100EngineEvent) => {
		if (event.type === "worker-stopped" && event.reason === "crash") smallLog.warn("worker crashed");
		else if (event.type === "sentence") smallLog.debug("sentence", { ...event.timing });
		else smallLog.info(event.type, { ...event });
	};
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
			small100: {
				// No manifest entry (a trimmed build): every pair reports missing, nothing to download.
				model: small100ModelSource(options.models) ?? staticSmall100Source(null),
				onEvent: onSmallEvent,
				...(small.spawn ? { spawn: small.spawn } : {}),
			},
		},
		bergamotWorker: path,
		ocrWorker: ocr.path,
		small100Worker: small.path,
	};
}
