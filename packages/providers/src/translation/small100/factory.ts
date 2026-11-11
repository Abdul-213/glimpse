// Registry factory for the SMaLL-100 provider (GLIM-43, GLIM-100). The app's provider context
// carries the model's install state (over the model manager) and may override how the
// inference Worker is spawned (bundled builds, like Bergamot and PaddleOCR).
import {
	boolean,
	type Infer,
	number,
	object,
	PROVIDER_IDS,
	type TranslationProviderFactory,
	withDefault,
} from "@glimpse/core";
import { SMALL100_DEFAULT_IDLE_MS, SMALL100_DEFAULT_THREADS, type Small100EngineEvent } from "./engine.ts";
import type { Small100ModelSource } from "./model.ts";
import type { Small100WorkerSpawner } from "./protocol.ts";
import { SMALL100_CAPABILITIES, SMALL100_INFO, Small100TranslationProvider } from "./provider.ts";

export const small100OptionsSchema = object({
	/** onnxruntime threads for one sentence. */
	threads: withDefault(number({ min: 1, max: 16, integer: true }), SMALL100_DEFAULT_THREADS),
	/** Stop the Worker (and free ~1 GB) after this many seconds idle. 0 = never. */
	idleSeconds: withDefault(number({ min: 0, max: 86_400, integer: true }), SMALL100_DEFAULT_IDLE_MS / 1000),
	/** Load the model right after start instead of on the first long-tail request. */
	warmOnStart: withDefault(boolean(), false),
});

export type Small100Options = Infer<typeof small100OptionsSchema>;

export interface Small100Context {
	readonly small100: {
		readonly model: Small100ModelSource;
		readonly spawn?: Small100WorkerSpawner;
		readonly onEvent?: (event: Small100EngineEvent) => void;
	};
}

export function small100Factory<Ctx extends Small100Context>(): TranslationProviderFactory<Ctx, Small100Options> {
	if (SMALL100_INFO.id !== PROVIDER_IDS.small100) throw new Error("small100 id drifted from PROVIDER_IDS");
	return {
		info: SMALL100_INFO,
		capabilities: SMALL100_CAPABILITIES,
		// Second in the default chain, after Bergamot (GLIM-85); `longTail` keeps it to the pairs
		// Bergamot can't serve.
		defaultRank: 10,
		options: small100OptionsSchema,
		create: (options, ctx) =>
			new Small100TranslationProvider({
				model: ctx.small100.model,
				threads: options.threads,
				idleMs: options.idleSeconds * 1000,
				warmOnStart: options.warmOnStart,
				...(ctx.small100.spawn ? { spawn: ctx.small100.spawn } : {}),
				...(ctx.small100.onEvent ? { onEvent: ctx.small100.onEvent } : {}),
			}),
	};
}
