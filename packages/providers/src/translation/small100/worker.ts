// The SMaLL-100 inference Worker (GLIM-100; ARCHITECTURE.md section 3: inference runs in its own
// Bun Worker, plain-data messages in and out). Owns the two onnxruntime-node sessions and the
// tokenizer, and runs the greedy decode loop (decode.ts) so none of that CPU work lands on the
// app's Bun worker. Jobs run one at a time; `cancel` is handled at once and checked between
// decoder steps.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import { DecodeCancelled, greedyDecodeLong, type Seq2SeqSession, SMALL100_CONFIG, type TensorKit } from "./decode.ts";
import { SMALL100_FILES } from "./model.ts";
import type { Small100HostMessage, Small100WorkerMessage } from "./protocol.ts";
import { Small100Tokenizer } from "./tokenizer.ts";

declare const self: Worker;

interface Loaded {
	readonly encoder: ort.InferenceSession;
	readonly decoder: ort.InferenceSession;
	readonly tokenizer: Small100Tokenizer;
}

let model: Loaded | null = null;
const cancelled = new Set<number>();
let queue: Promise<void> = Promise.resolve();

const post = (msg: Small100WorkerMessage) => self.postMessage(msg);

const kit: TensorKit = {
	int64: (values, dims) => new ort.Tensor("int64", BigInt64Array.from(values, BigInt), [...dims]),
	emptyKv: (heads, headDim) => new ort.Tensor("float32", new Float32Array(0), [1, heads, 0, headDim]),
	bool: (value) => new ort.Tensor("bool", [value], [1]),
};

function requireModel(): Loaded {
	if (!model) throw new Error("SMaLL-100 worker not initialised");
	return model;
}

async function run(m: Loaded, text: string, from: number, to: number, isCancelled: () => boolean) {
	return greedyDecodeLong(
		m.encoder as unknown as Seq2SeqSession,
		m.decoder as unknown as Seq2SeqSession,
		kit,
		SMALL100_CONFIG,
		m.tokenizer.encode(text),
		{ src: from, tgt: to },
		{ cancelled: isCancelled },
	);
}

async function handle(msg: Small100HostMessage): Promise<void> {
	switch (msg.type) {
		case "init": {
			const t0 = performance.now();
			const options: ort.InferenceSession.SessionOptions = {
				intraOpNumThreads: msg.threads,
				interOpNumThreads: 1,
				// As for OCR (GLIM-17): the arena grows with every new sequence length; off it
				// stays near the weights' size at no measurable cost.
				enableCpuMemArena: false,
				graphOptimizationLevel: "all",
			};
			const tokenizerJson = JSON.parse(readFileSync(join(msg.modelDir, SMALL100_FILES.tokenizer), "utf8")) as object;
			const [encoder, decoder] = await Promise.all([
				ort.InferenceSession.create(join(msg.modelDir, SMALL100_FILES.encoder), options),
				ort.InferenceSession.create(join(msg.modelDir, SMALL100_FILES.decoder), options),
			]);
			const tokenizer = new Small100Tokenizer(tokenizerJson);
			model = { encoder, decoder, tokenizer };
			post({ type: "ok", id: msg.id, result: { loadMs: performance.now() - t0, languages: tokenizer.languages } });
			return;
		}
		case "warmup": {
			const m = requireModel();
			const en = m.tokenizer.language("en");
			if (en === undefined) throw new Error("tokenizer has no __en__ token");
			const t0 = performance.now();
			await run(m, "Hello.", en, en, () => false);
			post({ type: "ok", id: msg.id, result: { ms: performance.now() - t0 } });
			return;
		}
		case "translate": {
			const m = requireModel();
			const from = m.tokenizer.language(msg.from);
			const to = m.tokenizer.language(msg.to);
			if (from === undefined || to === undefined) throw new Error(`no language token for ${msg.from} or ${msg.to}`);
			const isCancelled = () => cancelled.has(msg.id);
			const t0 = performance.now();
			for (const [index, sentence] of msg.sentences.entries()) {
				if (isCancelled()) throw new DecodeCancelled("cancelled");
				const r = await run(m, sentence, from, to, isCancelled);
				post({
					type: "sentence",
					id: msg.id,
					index,
					text: m.tokenizer.decode(r.ids),
					timing: { encodeMs: r.encodeMs, decodeMs: r.decodeMs, tokens: r.ids.length },
				});
			}
			post({ type: "ok", id: msg.id, result: { ms: performance.now() - t0 } });
			return;
		}
		case "cancel":
			return;
	}
}

self.onmessage = (event: MessageEvent<Small100HostMessage>) => {
	const msg = event.data;
	if (msg.type === "cancel") {
		cancelled.add(msg.id);
		return;
	}
	queue = queue.then(async () => {
		try {
			await handle(msg);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			post({ type: "error", id: msg.id, message, cancelled: error instanceof DecodeCancelled });
		} finally {
			cancelled.delete(msg.id);
		}
	});
};
