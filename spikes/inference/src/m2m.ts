// Fallback check: M2M-100 418M (MIT) int8 ONNX on onnxruntime-node from Bun, with a
// hand-written greedy decoder loop over the merged (KV-cache) decoder.
//   bun src/m2m.ts [src=ja] [tgt=en] "text"
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import * as ort from "onnxruntime-node";
import { MODELS } from "./models";

const DIR = join(MODELS, "m2m100_418M");
const LAYERS = 12;
const HEADS = 16;
const HEAD_DIM = 64;
const EOS = 2;

export class M2M100 {
  private constructor(private tok: Tokenizer, private enc: ort.InferenceSession, private dec: ort.InferenceSession, private langIds: Map<string, number>) {}

  static async create(threads = 4): Promise<M2M100> {
    const tj = JSON.parse(readFileSync(join(DIR, "tokenizer.json"), "utf8")) as { added_tokens: { id: number; content: string }[] };
    const tc = JSON.parse(readFileSync(join(DIR, "tokenizer_config.json"), "utf8")) as object;
    const tok = new Tokenizer(tj, tc);
    const langIds = new Map(tj.added_tokens.filter((t) => /^__[a-z]+__$/.test(t.content)).map((t) => [t.content.slice(2, -2), t.id]));
    const o = { intraOpNumThreads: threads, interOpNumThreads: 1 };
    const [enc, dec] = await Promise.all([
      ort.InferenceSession.create(join(DIR, "onnx", "encoder_model_quantized.onnx"), o),
      ort.InferenceSession.create(join(DIR, "onnx", "decoder_model_merged_quantized.onnx"), o),
    ]);
    return new M2M100(tok, enc, dec, langIds);
  }

  async translate(text: string, src: string, tgt: string, maxNew = 64): Promise<string> {
    const s = this.langIds.get(src);
    const t = this.langIds.get(tgt);
    if (s === undefined || t === undefined) throw new Error(`unknown language ${src} or ${tgt}`);
    // Source: __src__ tokens </s>. The tokenizer.json post-processor may already add </s>; build it explicitly.
    const body = this.tok.encode(text, { add_special_tokens: false }).ids;
    const ids = [s, ...body, EOS];
    const L = ids.length;
    const i64 = (xs: number[]) => BigInt64Array.from(xs.map(BigInt));
    const mask = new ort.Tensor("int64", i64(new Array(L).fill(1)), [1, L]);
    const encOut = await this.enc.run({ input_ids: new ort.Tensor("int64", i64(ids), [1, L]), attention_mask: mask });
    const hidden = encOut.last_hidden_state!;

    const out: number[] = [];
    let past: Record<string, ort.Tensor> = {};
    const empty = (len: number) => new ort.Tensor("float32", new Float32Array(0), [1, HEADS, len, HEAD_DIM]);
    for (let l = 0; l < LAYERS; l++) for (const k of ["decoder.key", "decoder.value", "encoder.key", "encoder.value"]) past[`past_key_values.${l}.${k}`] = empty(0);
    // decoder_start (</s>) then forced BOS = target language token
    let next: number[] = [EOS, t];
    let first = true;
    for (let step = 0; step < maxNew; step++) {
      const feeds: Record<string, ort.Tensor> = {
        input_ids: new ort.Tensor("int64", i64(next), [1, next.length]),
        encoder_attention_mask: mask,
        encoder_hidden_states: hidden,
        use_cache_branch: new ort.Tensor("bool", [!first], [1]),
        ...past,
      };
      const r = await this.dec.run(feeds);
      const logits = r.logits!;
      const [, T, V] = logits.dims as [number, number, number];
      const d = logits.data as Float32Array;
      const base = (T - 1) * V;
      let best = 0;
      for (let v = 1; v < V; v++) if (d[base + v]! > d[base + best]!) best = v;
      const np: Record<string, ort.Tensor> = {};
      for (let l = 0; l < LAYERS; l++) {
        np[`past_key_values.${l}.decoder.key`] = r[`present.${l}.decoder.key`]!;
        np[`past_key_values.${l}.decoder.value`] = r[`present.${l}.decoder.value`]!;
        // encoder KV is computed on the first step only; keep it afterwards
        np[`past_key_values.${l}.encoder.key`] = first ? r[`present.${l}.encoder.key`]! : past[`past_key_values.${l}.encoder.key`]!;
        np[`past_key_values.${l}.encoder.value`] = first ? r[`present.${l}.encoder.value`]! : past[`past_key_values.${l}.encoder.value`]!;
      }
      past = np;
      first = false;
      if (best === EOS) break;
      out.push(best);
      next = [best];
    }
    return this.tok.decode(out, { skip_special_tokens: true });
  }
}

if (import.meta.main) {
  const [src = "ja", tgt = "en", text = "明日の会議は午後三時に始まります。"] = process.argv.slice(2);
  const t0 = performance.now();
  const m = await M2M100.create();
  console.log(`load ${(performance.now() - t0).toFixed(0)} ms`);
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const r = await m.translate(text, src, tgt);
    console.log(`${(performance.now() - t).toFixed(0)} ms  ${text} -> ${r}`);
  }
  console.log(`peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
}
