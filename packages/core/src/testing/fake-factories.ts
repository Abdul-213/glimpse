// Registry factories that build the fake providers, for registry, settings and pipeline tests.

import type { OcrProviderFactory, TranslationProviderFactory } from "../providers/registry.ts";
import { boolean, type Infer, object, oneOf, withDefault } from "../schema/index.ts";
import { type FakeOcrOptions, FakeOcrProvider } from "./fake-ocr-provider.ts";
import { type FakeTranslationOptions, FakeTranslationProvider } from "./fake-translation-provider.ts";

/** Options schema the fake factories expose, so option validation can be tested. */
export const fakeOptionsSchema = object({
	quality: withDefault(oneOf(["fast", "best"] as const), "fast"),
	verbose: withDefault(boolean(), false),
});

export type FakeProviderOptions = Infer<typeof fakeOptionsSchema>;

export interface FakeFactoryOptions {
	readonly defaultRank?: number | null;
}

export function fakeOcrFactory<Ctx = unknown>(
	options: FakeOcrOptions & FakeFactoryOptions = {},
): OcrProviderFactory<Ctx, FakeProviderOptions> {
	const sample = new FakeOcrProvider(options);
	return {
		info: sample.info,
		capabilities: sample.capabilities,
		defaultRank: options.defaultRank === undefined ? (sample.info.kind === "cloud" ? null : 0) : options.defaultRank,
		options: fakeOptionsSchema,
		create: (opts) => new FakeOcrProvider({ ...options, options: opts }),
	};
}

export function fakeTranslationFactory<Ctx = unknown>(
	options: FakeTranslationOptions & FakeFactoryOptions = {},
): TranslationProviderFactory<Ctx, FakeProviderOptions> {
	const sample = new FakeTranslationProvider(options);
	return {
		info: sample.info,
		capabilities: sample.capabilities,
		defaultRank: options.defaultRank === undefined ? (sample.info.kind === "cloud" ? null : 0) : options.defaultRank,
		options: fakeOptionsSchema,
		create: (opts) => new FakeTranslationProvider({ ...options, options: opts }),
	};
}
