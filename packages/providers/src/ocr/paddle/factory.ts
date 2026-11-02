// Registry factory for the PaddleOCR provider (GLIM-43). The app registers it in its
// composition root with a context that carries the model file source.

import {
	array,
	boolean,
	type Infer,
	number,
	OCR_RECOGNIZERS,
	type OcrProviderFactory,
	type OcrRecognizer,
	object,
	oneOf,
	withDefault,
} from "@glimpse/core";
import {
	PADDLE_OCR_CAPABILITIES,
	PADDLE_OCR_DEFAULTS,
	PADDLE_OCR_INFO,
	type PaddleOcrContext,
	PaddleOcrProvider,
} from "./paddle-provider.ts";

const d = PADDLE_OCR_DEFAULTS;

export const paddleOcrOptionsSchema = object({
	threads: withDefault(number({ min: 0, max: 64, integer: true }), d.threads),
	spinning: withDefault(boolean(), d.spinning),
	liveThreads: withDefault(number({ min: 0, max: 64, integer: true }), d.liveThreads),
	liveSpinning: withDefault(boolean(), d.liveSpinning),
	detMaxSide: withDefault(number({ min: 320, max: 4096, integer: true }), d.detMaxSide),
	detMinSide: withDefault(number({ min: 0, max: 1920, integer: true }), d.detMinSide),
	minTextScore: withDefault(number({ min: 0, max: 1 }), d.minTextScore),
	recCacheSize: withDefault(number({ min: 0, max: 10_000, integer: true }), d.recCacheSize),
	preload: withDefault(
		array(oneOf(OCR_RECOGNIZERS as readonly OcrRecognizer[] as [OcrRecognizer, ...OcrRecognizer[]])),
		d.preload,
	),
	grouping: withDefault(oneOf(["blocks", "lines"] as const), d.grouping),
});

export type PaddleOcrOptionsInput = Infer<typeof paddleOcrOptionsSchema>;

export function paddleOcrFactory<Ctx extends PaddleOcrContext>(): OcrProviderFactory<Ctx, PaddleOcrOptionsInput> {
	return {
		info: PADDLE_OCR_INFO,
		capabilities: PADDLE_OCR_CAPABILITIES,
		defaultRank: 0,
		options: paddleOcrOptionsSchema,
		create: (options, ctx) => new PaddleOcrProvider(options, ctx),
	};
}
