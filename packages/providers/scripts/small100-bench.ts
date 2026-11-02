// SMaLL-100 latency, memory and output check (GLIM-100), in-process on onnxruntime-node with
// the provider's own tokenizer and decode loop (the Worker runs the same code).
//
//   bun packages/providers/scripts/small100-bench.ts --model <dir> [--flores <flores101_dataset/devtest>]
//       [--langs sw,zu,ja] [--n 20] [--to en] [--threads 4] [--out hyp.json]
//
// <dir> holds encoder_model_quantized.onnx, decoder_model_merged_quantized.onnx and
// tokenizer.json (the installed model folder, or GLIMPSE_SMALL100_DIR). Without --flores it
// translates a few built-in sentences. With --out it writes hypotheses and references for
// scoring (chrF) outside the app.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as ort from "onnxruntime-node";
import {
	greedyDecode,
	type Seq2SeqSession,
	SMALL100_CONFIG,
	Small100Tokenizer,
} from "../src/translation/small100/index.ts";

const { values } = parseArgs({
	options: {
		model: { type: "string" },
		flores: { type: "string" },
		langs: { type: "string", default: "sw,zu,yo,am,ka,hy,km,my,ps,ne,ja,de" },
		n: { type: "string", default: "10" },
		to: { type: "string", default: "en" },
		threads: { type: "string", default: "4" },
		out: { type: "string" },
		scheme: { type: "string", default: "small100" },
		layers: { type: "string" },
		/** onnxruntime defaults (CPU arena on, default graph optimisation) instead of the Worker's options. */
		"ort-defaults": { type: "boolean", default: false },
	},
});

const dir = values.model ?? process.env["GLIMPSE_SMALL100_DIR"];
if (!dir) throw new Error("--model <dir> is required");
const FLORES: Record<string, string> = {
	sw: "swh",
	zu: "zul",
	yo: "yor",
	am: "amh",
	ka: "kat",
	hy: "hye",
	km: "khm",
	my: "mya",
	si: "sin",
	ne: "npi",
	ja: "jpn",
	de: "deu",
	en: "eng",
	ps: "pus",
	xh: "xho",
};
const BUILT_IN: Record<string, string[]> = {
	ja: ["明日の会議は午後三時に始まります。"],
	sw: ["Habari za asubuhi, unaendeleaje?"],
	de: ["Die Datei konnte nicht gespeichert werden."],
};

const threads = Number(values.threads);
const options: ort.InferenceSession.SessionOptions = values["ort-defaults"]
	? { intraOpNumThreads: threads, interOpNumThreads: 1 }
	: { intraOpNumThreads: threads, interOpNumThreads: 1, enableCpuMemArena: false, graphOptimizationLevel: "all" };
const t0 = performance.now();
const tokJson = JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")) as object;
const tok = new Small100Tokenizer(tokJson);
const [encoder, decoder] = await Promise.all([
	ort.InferenceSession.create(join(dir, "encoder_model_quantized.onnx"), options),
	ort.InferenceSession.create(join(dir, "decoder_model_merged_quantized.onnx"), options),
]);
const loadMs = performance.now() - t0;
const rssAfterLoad = process.memoryUsage().rss;
const config = {
	...SMALL100_CONFIG,
	scheme: values.scheme === "m2m100" ? ("m2m100" as const) : ("small100" as const),
	...(values.layers ? { decoderLayers: Number(values.layers) } : {}),
};
const kit = {
	int64: (v: readonly number[], dims: readonly number[]) =>
		new ort.Tensor("int64", BigInt64Array.from(v, BigInt), [...dims]),
	emptyKv: (heads: number, headDim: number) => new ort.Tensor("float32", new Float32Array(0), [1, heads, 0, headDim]),
	bool: (v: boolean) => new ort.Tensor("bool", [v], [1]),
};

const to = values.to ?? "en";
const tgt = tok.language(to);
if (tgt === undefined) throw new Error(`no language token for ${to}`);
const n = Number(values.n);
const lines = (code: string): string[] => {
	if (!values.flores) return BUILT_IN[code] ?? [];
	const file = FLORES[code];
	if (!file) throw new Error(`no FLORES file name for ${code}`);
	return readFileSync(join(values.flores, `${file}.devtest`), "utf8")
		.split("\n")
		.slice(0, n);
};
const refs = values.flores ? lines(to) : [];

const results: Record<string, { hyp: string[]; ref: string[]; ms: number[] }> = {};
const all: number[] = [];
let tokensOut = 0;
let decodeMsTotal = 0;
let encodeMsTotal = 0;
const sess = { encoder: encoder as unknown as Seq2SeqSession, decoder: decoder as unknown as Seq2SeqSession };
// Warm both sessions once (first runs pay for allocations), as the provider's warmup does.
await greedyDecode(sess.encoder, sess.decoder, kit, config, tok.encode("Hello."), { src: tgt, tgt });
for (const code of (values.langs ?? "").split(",").filter(Boolean)) {
	const src = tok.language(code);
	if (src === undefined) throw new Error(`no language token for ${code}`);
	const hyp: string[] = [];
	const ms: number[] = [];
	for (const line of lines(code)) {
		const t = performance.now();
		const r = await greedyDecode(sess.encoder, sess.decoder, kit, config, tok.encode(line), { src, tgt });
		const elapsed = performance.now() - t;
		ms.push(elapsed);
		all.push(elapsed);
		tokensOut += r.ids.length;
		decodeMsTotal += r.decodeMs;
		encodeMsTotal += r.encodeMs;
		hyp.push(tok.decode(r.ids));
	}
	results[code] = { hyp, ref: values.flores ? refs.slice(0, hyp.length) : [], ms };
	const sorted = [...ms].sort((a, b) => a - b);
	console.log(
		`${code}->${to}  n=${ms.length}  p50 ${sorted[Math.floor(sorted.length / 2)]?.toFixed(0)} ms  max ${sorted.at(-1)?.toFixed(0)} ms  | ${hyp[0]?.slice(0, 90)}`,
	);
}
const sorted = [...all].sort((a, b) => a - b);
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]?.toFixed(0);
console.log(
	JSON.stringify({
		model: dir,
		threads,
		loadMs: Math.round(loadMs),
		sentences: all.length,
		p50: pct(0.5),
		p90: pct(0.9),
		meanMs: Math.round(all.reduce((a, b) => a + b, 0) / Math.max(1, all.length)),
		encodeShare: +(encodeMsTotal / (encodeMsTotal + decodeMsTotal)).toFixed(2),
		msPerOutputToken: +(decodeMsTotal / Math.max(1, tokensOut)).toFixed(1),
		rssAfterLoadMB: Math.round(rssAfterLoad / 2 ** 20),
		peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
	}),
);
if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 1));
