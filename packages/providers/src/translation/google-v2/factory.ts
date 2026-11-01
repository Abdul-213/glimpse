// Registry factory for Google Cloud Translation v2 (GLIM-43, GLIM-61). Cloud: `defaultRank:
// null`, so it is only ever used when the user picks it in Settings › Providers, and the
// registry removes it from a chain where it follows a local translator.
import { boolean, type Infer, number, object, type TranslationProviderFactory, withDefault } from "@glimpse/core";
import type { GoogleCloudContext } from "../../google/common.ts";
import {
	GOOGLE_TRANSLATE_CAPABILITIES,
	GOOGLE_TRANSLATE_DEFAULTS,
	GOOGLE_TRANSLATE_INFO,
	GoogleTranslateProvider,
} from "./provider.ts";

const d = GOOGLE_TRANSLATE_DEFAULTS;

export const googleTranslateOptionsSchema = object({
	timeoutMs: withDefault(number({ min: 1000, max: 60_000, integer: true }), d.timeoutMs),
	refreshLanguages: withDefault(boolean(), d.refreshLanguages),
});

export type GoogleTranslateOptionsInput = Infer<typeof googleTranslateOptionsSchema>;

export function googleTranslateFactory<Ctx extends GoogleCloudContext>(): TranslationProviderFactory<
	Ctx,
	GoogleTranslateOptionsInput
> {
	return {
		info: GOOGLE_TRANSLATE_INFO,
		capabilities: GOOGLE_TRANSLATE_CAPABILITIES,
		defaultRank: null,
		options: googleTranslateOptionsSchema,
		create: (options, ctx) => new GoogleTranslateProvider(options, ctx),
	};
}
