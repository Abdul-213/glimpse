// Registry factory for the Bergamot provider (GLIM-43). The app's provider context must
// carry a `bergamot` pack source (implemented over the model download manager) and may
// override how the inference Worker is spawned (bundled builds).
import {
	type Infer,
	type LanguageCode,
	number,
	object,
	PROVIDER_IDS,
	type TranslationProviderFactory,
	withDefault,
} from "@glimpse/core";
import { DEFAULT_IDLE_MS, DEFAULT_MAX_LOADED_PACKS, type EngineEvent } from "./engine.ts";
import type { BergamotPackSource } from "./packs.ts";
import type { WorkerSpawner } from "./protocol.ts";
import { BERGAMOT_CAPABILITIES, BERGAMOT_INFO, BergamotTranslationProvider } from "./provider.ts";

export const bergamotOptionsSchema = object({
	/** Packs kept in memory at once (~0.1-0.4 GB each). A pivot route needs two. */
	maxLoadedPacks: withDefault(number({ min: 2, max: 8, integer: true }), DEFAULT_MAX_LOADED_PACKS),
	/** Stop the Worker (and free its memory) after this many seconds idle. 0 = never. */
	idleSeconds: withDefault(number({ min: 0, max: 86_400, integer: true }), DEFAULT_IDLE_MS / 1000),
});

export type BergamotOptions = Infer<typeof bergamotOptionsSchema>;

export interface BergamotContext {
	readonly bergamot: {
		readonly packs: BergamotPackSource;
		readonly spawn?: WorkerSpawner;
		readonly onEvent?: (event: EngineEvent) => void;
		/** Pairs `warmup()` loads and warms (the user's sources -> target), read at create time. */
		readonly warmPairs?: () => readonly { readonly from: LanguageCode; readonly to: LanguageCode }[];
	};
}

export function bergamotFactory<Ctx extends BergamotContext>(): TranslationProviderFactory<Ctx, BergamotOptions> {
	if (BERGAMOT_INFO.id !== PROVIDER_IDS.bergamot) throw new Error("bergamot id drifted from PROVIDER_IDS");
	return {
		info: BERGAMOT_INFO,
		capabilities: BERGAMOT_CAPABILITIES,
		defaultRank: 0,
		options: bergamotOptionsSchema,
		create: (options, ctx) =>
			new BergamotTranslationProvider({
				packs: ctx.bergamot.packs,
				maxLoadedPacks: options.maxLoadedPacks,
				idleMs: options.idleSeconds * 1000,
				...(ctx.bergamot.spawn ? { spawn: ctx.bergamot.spawn } : {}),
				...(ctx.bergamot.onEvent ? { onEvent: ctx.bergamot.onEvent } : {}),
				...(ctx.bergamot.warmPairs ? { warmPairs: ctx.bergamot.warmPairs() } : {}),
			}),
	};
}
