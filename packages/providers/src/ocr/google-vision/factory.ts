// Registry factory for Google Cloud Vision (GLIM-43, GLIM-60). Cloud: `defaultRank: null`, so
// it is only ever used when the user picks it in Settings › Providers.
import { type Infer, number, type OcrProviderFactory, object, oneOf, withDefault } from "@glimpse/core";
import type { GoogleCloudContext } from "../../google/common.ts";
import {
	GOOGLE_VISION_CAPABILITIES,
	GOOGLE_VISION_DEFAULTS,
	GOOGLE_VISION_INFO,
	GoogleVisionProvider,
} from "./provider.ts";

const d = GOOGLE_VISION_DEFAULTS;

export const googleVisionOptionsSchema = object({
	feature: withDefault(oneOf(["auto", "text", "document"] as const), d.feature),
	unit: withDefault(oneOf(["block", "paragraph"] as const), d.unit),
	timeoutMs: withDefault(number({ min: 1000, max: 60_000, integer: true }), d.timeoutMs),
});

export type GoogleVisionOptionsInput = Infer<typeof googleVisionOptionsSchema>;

export function googleVisionFactory<Ctx extends GoogleCloudContext>(): OcrProviderFactory<
	Ctx,
	GoogleVisionOptionsInput
> {
	return {
		info: GOOGLE_VISION_INFO,
		capabilities: GOOGLE_VISION_CAPABILITIES,
		defaultRank: null,
		options: googleVisionOptionsSchema,
		create: (options, ctx) => new GoogleVisionProvider(options, ctx),
	};
}
