// Bergamot (Firefox Translations) runtime inside Bun.
// Loads Firefox's own bergamot-translator.wasm + matching JS glue (MPL-2.0) and runs
// Marian int8 models with the WASM's built-in fallback gemm (no WebAssembly.mozIntGemm outside Firefox).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInThisContext } from "node:vm";

/** Byte alignment Bergamot requires for each file role (same as Firefox). */
export const ALIGNMENT: Record<string, number> = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 };

/** Marian options as Firefox passes them: greedy, int8 shifted gemm, 128-token sentence breaks. */
export const MODEL_CONFIG = `
beam-size: 1
normalize: 1.0
word-penalty: 0
max-length-break: 128
mini-batch-words: 1024
workspace: 128
max-length-factor: 2.0
skip-cost: true
cpu-threads: 0
quiet: true
quiet-translation: true
gemm-precision: int8shiftAlphaAll
alignment: soft
`;

// Minimal shapes of the embind objects we touch. The glue is untyped emscripten output.
interface Deletable { delete(): void }
interface AlignedMemory extends Deletable { getByteArrayView(): Uint8Array }
interface Vec<T> extends Deletable { push_back(v: T): void; size(): number; get(i: number): T }
interface Response extends Deletable { getTranslatedText(): string }
export interface TranslationModel extends Deletable { readonly __brand?: "model" }
interface BlockingService extends Deletable {
  translate(m: TranslationModel, t: Vec<string>, o: Vec<ResponseOptions>): Vec<Response>;
  translateViaPivoting(a: TranslationModel, b: TranslationModel, t: Vec<string>, o: Vec<ResponseOptions>): Vec<Response>;
}
interface ResponseOptions { qualityScores: boolean; alignment: boolean; html: boolean }
export interface BergamotModule {
  AlignedMemory: new (size: number, align: number) => AlignedMemory;
  AlignedMemoryList: new () => Vec<AlignedMemory>;
  VectorString: new () => Vec<string>;
  VectorResponseOptions: new () => Vec<ResponseOptions>;
  TranslationModel: new (from: string, to: string, cfg: string, model: AlignedMemory, lex: AlignedMemory, vocabs: Vec<AlignedMemory>, qe: null) => TranslationModel;
  BlockingService: new (o: { cacheSize: number }) => BlockingService;
}

export interface PackManifest { src: string; tgt: string; version: string; architecture?: string; files: Record<string, string> }

/** Instantiate the WASM. `gemm` reports which matrix-multiply path the glue chose. */
export async function loadRuntime(dir: string): Promise<{ mod: BergamotModule; gemm: string }> {
  const glue = readFileSync(join(dir, "bergamot-translator.js"), "utf8");
  const loadBergamot = runInThisContext(`(function(){\n${glue}\nreturn loadBergamot;})()`, { filename: "bergamot-translator.js" }) as (m: object) => void;
  const wasmBinary = readFileSync(join(dir, "bergamot-translator.wasm"));
  let gemm = "unknown";
  const log = console.log;
  console.log = (...a: unknown[]) => { gemm = a.map(String).join(" "); };
  try {
    const mod = await new Promise<BergamotModule>((resolve, reject) => {
      const m: Record<string, unknown> = {
        INITIAL_MEMORY: 234_291_200,
        wasmBinary,
        print: () => undefined,
        printErr: () => undefined,
        onAbort: (r: unknown) => reject(new Error(`bergamot aborted: ${String(r)}`)),
        onRuntimeInitialized: () => resolve(m as unknown as BergamotModule),
      };
      loadBergamot(m);
    });
    return { mod, gemm };
  } finally {
    console.log = log;
  }
}

function aligned(mod: BergamotModule, role: string, path: string): AlignedMemory {
  const bytes = readFileSync(path);
  const mem = new mod.AlignedMemory(bytes.byteLength, ALIGNMENT[role] ?? 64);
  mem.getByteArrayView().set(bytes);
  return mem;
}

export function loadPack(mod: BergamotModule, packDir: string): { model: TranslationModel; manifest: PackManifest } {
  const manifest = JSON.parse(readFileSync(join(packDir, "pack.json"), "utf8")) as PackManifest;
  const f = (role: string) => {
    const name = manifest.files[role];
    if (!name) throw new Error(`pack ${packDir} has no ${role}`);
    return join(packDir, name);
  };
  const vocabs = new mod.AlignedMemoryList();
  if (manifest.files.vocab) vocabs.push_back(aligned(mod, "vocab", f("vocab")));
  else {
    vocabs.push_back(aligned(mod, "srcvocab", f("srcvocab")));
    vocabs.push_back(aligned(mod, "trgvocab", f("trgvocab")));
  }
  const model = new mod.TranslationModel(manifest.src, manifest.tgt, MODEL_CONFIG, aligned(mod, "model", f("model")), aligned(mod, "lex", f("lex")), vocabs, null);
  return { model, manifest };
}

export class Translator {
  private service: BlockingService;
  constructor(private mod: BergamotModule) {
    this.service = new mod.BlockingService({ cacheSize: 0 });
  }
  /** Translate with one model, or two (pivot through English) when `second` is given. */
  translate(texts: string[], first: TranslationModel, second?: TranslationModel): string[] {
    const v = new this.mod.VectorString();
    const o = new this.mod.VectorResponseOptions();
    let r: Vec<Response> | null = null;
    try {
      for (const t of texts) {
        v.push_back(t);
        o.push_back({ qualityScores: false, alignment: false, html: false });
      }
      r = second ? this.service.translateViaPivoting(first, second, v, o) : this.service.translate(first, v, o);
      const out: string[] = [];
      for (let i = 0; i < texts.length; i++) out.push(r.get(i).getTranslatedText());
      return out;
    } finally {
      v.delete();
      o.delete();
      r?.delete();
    }
  }
}
