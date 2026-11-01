// The provider registry and the context provider factories get (GLIM-43, GLIM-101).
// Every implementation in @glimpse/providers registers here; the composition root builds the
// context from app services. No Electrobun imports: tested on Linux.
import type { Logger, ProviderRegistry } from "@glimpse/core";
import { type BergamotContext, bergamotFactory, type EngineEvent } from "@glimpse/providers/translation/bergamot";
import type { ModelManagerPackSource } from "./translation/bergamot-packs.ts";
import { bergamotSpawner } from "./translation/bergamot-worker.ts";

/** What provider factories may use. Grows with each provider (PaddleOCR, cloud: fetch, secrets). */
export type AppProviderContext = BergamotContext;

export function registerProviders(registry: ProviderRegistry<AppProviderContext>): void {
	registry.register(bergamotFactory<AppProviderContext>());
}

export interface ProviderContextOptions {
	readonly packs: ModelManagerPackSource;
	/** Directory of the main bundle (`import.meta.dir` of src/bun/index.ts). */
	readonly mainDir: string;
	readonly warmPairs: NonNullable<BergamotContext["bergamot"]["warmPairs"]>;
	readonly log: Logger;
	readonly env?: Record<string, string | undefined>;
}

export function providerContext(options: ProviderContextOptions): {
	readonly ctx: AppProviderContext;
	readonly bergamotWorker: string | null;
} {
	const { spawn, path } = bergamotSpawner(options.mainDir, options.env);
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
		},
		bergamotWorker: path,
	};
}
