// Greedy seq2seq decoding over an ONNX encoder and a merged (KV-cache) decoder, as exported by
// Optimum for M2M100ForConditionalGeneration (GLIM-100; spikes/inference/src/m2m.ts). Pure: the
// sessions and tensor constructors come in through small interfaces, so the loop is tested on
// Linux with a scripted fake and runs unchanged on onnxruntime-node in the Worker.
//
// Two prompt schemes share the loop:
//   small100  encoder [__tgt__, ...source, </s>], decoder starts at </s>    (SMaLL-100)
//   m2m100    encoder [__src__, ...source, </s>], decoder </s> __tgt__ ...  (M2M-100, forced BOS)
//
// Guards for a small model decoding greedily: at most `maxNewTokens` (scaled to the input),
// and no repeated `noRepeatNgram`-gram (transformers' no_repeat_ngram_size), which stops the
// "the the the" loops greedy search falls into on short or odd inputs.

export interface Seq2SeqTensor {
	readonly data: unknown;
	readonly dims: readonly number[];
}

export interface Seq2SeqSession {
	run(feeds: Record<string, Seq2SeqTensor>): Promise<Record<string, Seq2SeqTensor>>;
}

/** Tensor constructors (onnxruntime-node's `Tensor` in the Worker, plain objects in tests). */
export interface TensorKit {
	int64(values: readonly number[], dims: readonly number[]): Seq2SeqTensor;
	/** An empty float32 KV tensor of shape [1, heads, 0, headDim]. */
	emptyKv(heads: number, headDim: number): Seq2SeqTensor;
	bool(value: boolean): Seq2SeqTensor;
}

export interface Seq2SeqConfig {
	readonly scheme: "small100" | "m2m100";
	readonly decoderLayers: number;
	readonly heads: number;
	readonly headDim: number;
	readonly eos: number;
	/** Longest output, whatever the input (the model's max_length). */
	readonly maxLength: number;
	/** Ban repeating n-grams of this size; 0 turns it off. */
	readonly noRepeatNgram: number;
}

/** SMaLL-100 (alirezamsh/small100): 12 encoder / 3 decoder layers, d_model 1024, 16 heads. */
export const SMALL100_CONFIG: Seq2SeqConfig = {
	scheme: "small100",
	decoderLayers: 3,
	heads: 16,
	headDim: 64,
	eos: 2,
	maxLength: 256,
	noRepeatNgram: 4,
};

export interface DecodeOptions {
	/** Checked between decoder steps; true stops with `DecodeCancelled`. */
	readonly cancelled?: () => boolean;
}

export class DecodeCancelled extends Error {
	override readonly name = "AbortError";
}

export interface DecodeResult {
	readonly ids: number[];
	readonly steps: number;
	readonly encodeMs: number;
	readonly decodeMs: number;
	/** Stopped by the length limit rather than </s>. */
	readonly truncated: boolean;
}

/** Output budget for a source of `sourceTokens` tokens: about 2x, at least 16, at most maxLength. */
export function maxNewTokens(sourceTokens: number, config: Pick<Seq2SeqConfig, "maxLength">): number {
	return Math.max(16, Math.min(config.maxLength, Math.ceil(sourceTokens * 2) + 10));
}

/**
 * Longest source piece decoded in one go. The model has 1024 positions; a "sentence" longer
 * than this (a run-on line with no punctuation) is decoded in consecutive slices instead.
 */
export const MAX_SOURCE_TOKENS = 400;

/** Split a long source into slices of at most `max` tokens. */
export function sliceSource(body: readonly number[], max = MAX_SOURCE_TOKENS): number[][] {
	if (body.length <= max) return [[...body]];
	const out: number[][] = [];
	for (let i = 0; i < body.length; i += max) out.push(body.slice(i, i + max));
	return out;
}

/** `greedyDecode` over `sliceSource(body)`, concatenating the outputs and timings. */
export async function greedyDecodeLong(
	encoder: Seq2SeqSession,
	decoder: Seq2SeqSession,
	kit: TensorKit,
	config: Seq2SeqConfig,
	body: readonly number[],
	langs: { readonly src: number; readonly tgt: number },
	options: DecodeOptions = {},
): Promise<DecodeResult> {
	let acc: DecodeResult = { ids: [], steps: 0, encodeMs: 0, decodeMs: 0, truncated: false };
	for (const slice of sliceSource(body)) {
		const r = await greedyDecode(encoder, decoder, kit, config, slice, langs, options);
		acc = {
			ids: [...acc.ids, ...r.ids],
			steps: acc.steps + r.steps,
			encodeMs: acc.encodeMs + r.encodeMs,
			decodeMs: acc.decodeMs + r.decodeMs,
			truncated: acc.truncated || r.truncated,
		};
	}
	return acc;
}

/** The encoder input ids for `body` (already tokenised, no specials). */
export function encoderIds(body: readonly number[], src: number, tgt: number, config: Seq2SeqConfig): number[] {
	return [config.scheme === "small100" ? tgt : src, ...body, config.eos];
}

/** Tokens that would complete an n-gram already in `history` (transformers' no_repeat_ngram). */
export function bannedNext(history: readonly number[], n: number): Set<number> {
	const banned = new Set<number>();
	if (n <= 0 || history.length < n - 1) return banned;
	const prefix = history.slice(history.length - (n - 1));
	for (let i = 0; i + n <= history.length; i++) {
		let match = true;
		for (let j = 0; j < n - 1; j++) {
			if (history[i + j] !== prefix[j]) {
				match = false;
				break;
			}
		}
		const next = history[i + n - 1];
		if (match && next !== undefined) banned.add(next);
	}
	return banned;
}

/** Index of the largest logit in the last position, skipping `banned` and id 0 (<s>). */
export function argmaxLast(logits: Seq2SeqTensor, banned: ReadonlySet<number>): number {
	const dims = logits.dims;
	const vocab = dims[dims.length - 1] ?? 0;
	const steps = dims[dims.length - 2] ?? 1;
	const data = logits.data as Float32Array;
	const base = (steps - 1) * vocab;
	let best = -1;
	let bestValue = Number.NEGATIVE_INFINITY;
	for (let v = 1; v < vocab; v++) {
		const value = data[base + v] ?? Number.NEGATIVE_INFINITY;
		if (value > bestValue && !banned.has(v)) {
			bestValue = value;
			best = v;
		}
	}
	return best;
}

/**
 * Translate one tokenised sentence. `body` holds the source pieces' ids (no language token,
 * no </s>); `src` / `tgt` are the language token ids. Returns the generated ids without
 * </s> (and without the forced target token for m2m100).
 */
export async function greedyDecode(
	encoder: Seq2SeqSession,
	decoder: Seq2SeqSession,
	kit: TensorKit,
	config: Seq2SeqConfig,
	body: readonly number[],
	langs: { readonly src: number; readonly tgt: number },
	options: DecodeOptions = {},
	now: () => number = () => performance.now(),
): Promise<DecodeResult> {
	const ids = encoderIds(body, langs.src, langs.tgt, config);
	const length = ids.length;
	const t0 = now();
	const mask = kit.int64(new Array<number>(length).fill(1), [1, length]);
	const encoded = await encoder.run({ input_ids: kit.int64(ids, [1, length]), attention_mask: mask });
	const hidden = encoded["last_hidden_state"];
	if (!hidden) throw new Error("encoder returned no last_hidden_state");
	const t1 = now();

	const kinds = ["decoder.key", "decoder.value", "encoder.key", "encoder.value"] as const;
	let past: Record<string, Seq2SeqTensor> = {};
	for (let l = 0; l < config.decoderLayers; l++) {
		for (const k of kinds) past[`past_key_values.${l}.${k}`] = kit.emptyKv(config.heads, config.headDim);
	}
	const forced = config.scheme === "m2m100" ? [langs.tgt] : [];
	let next: number[] = [config.eos, ...forced];
	const out: number[] = [];
	const limit = maxNewTokens(body.length, config);
	let first = true;
	let steps = 0;
	let truncated = true;
	for (let step = 0; step < limit; step++) {
		if (options.cancelled?.()) throw new DecodeCancelled("cancelled");
		const result = await decoder.run({
			input_ids: kit.int64(next, [1, next.length]),
			encoder_attention_mask: mask,
			encoder_hidden_states: hidden,
			use_cache_branch: kit.bool(!first),
			...past,
		});
		steps++;
		const logits = result["logits"];
		if (!logits) throw new Error("decoder returned no logits");
		const best = argmaxLast(logits, bannedNext([...forced, ...out], config.noRepeatNgram));
		const nextPast: Record<string, Seq2SeqTensor> = {};
		for (let l = 0; l < config.decoderLayers; l++) {
			for (const k of kinds) {
				// The encoder's keys / values are computed on the first step only; reuse them after.
				const fresh = result[`present.${l}.${k}`];
				const keep = k.startsWith("encoder") && !first ? past[`past_key_values.${l}.${k}`] : fresh;
				if (!keep) throw new Error(`decoder returned no present.${l}.${k}`);
				nextPast[`past_key_values.${l}.${k}`] = keep;
			}
		}
		past = nextPast;
		first = false;
		if (best === config.eos || best < 0) {
			truncated = false;
			break;
		}
		out.push(best);
		next = [best];
	}
	return { ids: out, steps, encodeMs: t1 - t0, decodeMs: now() - t1, truncated };
}
