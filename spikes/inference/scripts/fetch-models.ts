// Downloads every model this spike uses into ./models (gitignored), verifying SHA-256.
//   bun scripts/fetch-models.ts            -> OCR + Bergamot (ja,zh,de<->en) + runtime
//   bun scripts/fetch-models.ts --m2m      -> also the M2M-100 418M int8 ONNX fallback (~0.9 GB)
// Re-running skips files whose hash already matches.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..", "models");

async function sha256(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchTo(url: string, dest: string, expectSha?: string): Promise<Uint8Array> {
  if (existsSync(dest)) {
    const have = new Uint8Array(readFileSync(dest));
    if (!expectSha || (await sha256(have)) === expectSha) return have;
  }
  mkdirSync(dirname(dest), { recursive: true });
  const t0 = performance.now();
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (expectSha) {
    const got = await sha256(bytes);
    if (got !== expectSha) throw new Error(`sha256 mismatch for ${url}: ${got} != ${expectSha}`);
  }
  writeFileSync(dest, bytes);
  console.log(`  ${(bytes.byteLength / 1e6).toFixed(1).padStart(6)} MB  ${((performance.now() - t0) / 1000).toFixed(1)}s  ${dest.replace(ROOT + "/", "")}`);
  return bytes;
}

// ---------------------------------------------------------------- OCR (RapidOCR's ONNX exports of PP-OCRv5)
// Source of truth: https://github.com/RapidAI/RapidOCR/blob/main/python/rapidocr/default_models.yaml (v3.10.0 pins)
const RAPID = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0";
const OCR: { file: string; sha: string; dict?: string }[] = [
  { file: "det/ch_PP-OCRv5_det_mobile.onnx", sha: "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae" },
  { file: "rec/ch_PP-OCRv5_rec_mobile.onnx", sha: "5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5", dict: "ch_PP-OCRv5_rec_mobile/ppocrv5_dict.txt" },
  { file: "rec/korean_PP-OCRv5_rec_mobile.onnx", sha: "cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b", dict: "korean_PP-OCRv5_rec_mobile/ppocrv5_korean_dict.txt" },
  { file: "rec/latin_PP-OCRv5_rec_mobile.onnx", sha: "b20bd37c168a570f583afbc8cd7925603890efbcdc000a59e22c269d160b5f5a", dict: "latin_PP-OCRv5_rec_mobile/ppocrv5_latin_dict.txt" },
  { file: "rec/en_PP-OCRv5_rec_mobile.onnx", sha: "c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8", dict: "en_PP-OCRv5_rec_mobile/ppocrv5_en_dict.txt" },
  { file: "rec/eslav_PP-OCRv5_rec_mobile.onnx", sha: "08705d6721849b1347d26187f15a5e362c431963a2a62bfff4feac578c489aab", dict: "eslav_PP-OCRv5_rec_mobile/ppocrv5_eslav_dict.txt" },
  { file: "rec/cyrillic_PP-OCRv5_rec_mobile.onnx", sha: "90f761b4bfcce0c8c561c0cb5c887b0971d3ec01c32164bdf7374a35b0982711", dict: "cyrillic_PP-OCRv5_rec_mobile/ppocrv5_cyrillic_dict.txt" },
  { file: "rec/arabic_PP-OCRv5_rec_mobile.onnx", sha: "c1192e632d0baa9146ae5b756a0e635e3dc63c1733737ebfd1629e87144e9295", dict: "arabic_PP-OCRv5_rec_mobile/ppocrv5_arabic_dict.txt" },
  { file: "rec/devanagari_PP-OCRv5_rec_mobile.onnx", sha: "d6f0a906580e3fa6b324a318718f1f31f268b6ea8ef985f91c2012a37f52c91e", dict: "devanagari_PP-OCRv5_rec_mobile/ppocrv5_devanagari_dict.txt" },
  { file: "rec/th_PP-OCRv5_rec_mobile.onnx", sha: "de541dd83161c241ff426f7ecfd602a0ba77d686cf3ab9a6c255ea82fd08006e", dict: "th_PP-OCRv5_rec_mobile/ppocrv5_th_dict.txt" },
  { file: "rec/el_PP-OCRv5_rec_mobile.onnx", sha: "b4368bccd557123c702b7549fee6cd1e94b581337d1c9b65310f109131542b7f", dict: "el_PP-OCRv5_rec_mobile/ppocrv5_el_dict.txt" },
];

// ---------------------------------------------------------------- Bergamot (Firefox Remote Settings)
const RS = "https://firefox.settings.services.mozilla.com/v1/buckets/main/collections";
const CDN = "https://firefox-settings-attachments.cdn.mozilla.net/";
// The JS glue must match the WASM byte for byte (emscripten import names). Firefox ships it in-tree:
// toolkit/components/translations/bergamot-translator/bergamot-translator.js. Pinned commit.
const GLUE_COMMIT = process.env.GLUE_COMMIT ?? "48d55cf7ec80093903e2ef7f58b61a84a22ef716";
const GLUE_SHA256 = "faff1ef6285b0d26f01787776fd49299dfb756ecb9688aa990c250e66797b47d"; // v0.6.0+eea6e5a8, same as firefox main on 2026-11-01
const GLUE_URL = `https://raw.githubusercontent.com/mozilla-firefox/firefox/${GLUE_COMMIT}/toolkit/components/translations/bergamot-translator/bergamot-translator.js`;
const PAIRS: [string, string][] = [["ja", "en"], ["zh-Hans", "en"], ["de", "en"], ["en", "de"]];

interface RsAttachment { hash: string; size: number; filename: string; location: string }
interface ModelRecordV2 {
  name: string; version: string; fileType: string; architecture: string;
  sourceLanguage: string; targetLanguage: string; filter_expression: string;
  decompressedHash: string; decompressedSize: number; attachment: RsAttachment;
}
interface WasmRecordV2 { name: string; version: string; release: string; decompressedHash: string; attachment: RsAttachment }

/** Desktop release Firefox: keep records whose filter is empty or explicitly non-Android. */
export function desktopRecord(filter: string): boolean {
  const f = filter.trim();
  return f === "" || f === "env.appinfo.OS != 'Android'";
}

function zstd(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(Bun.zstdDecompressSync(bytes));
}

async function fetchZst(att: RsAttachment, decompressedHash: string, dest: string): Promise<void> {
  if (existsSync(dest) && (await sha256(new Uint8Array(readFileSync(dest)))) === decompressedHash) return;
  const zbytes = await fetchTo(CDN + att.location, dest + ".zst", att.hash);
  const raw = zstd(zbytes);
  const got = await sha256(raw);
  if (got !== decompressedHash) throw new Error(`decompressed hash mismatch ${dest}`);
  writeFileSync(dest, raw);
  unlinkSync(dest + ".zst"); // keep only the unpacked file (what the runtime reads)
}

async function bergamot(): Promise<void> {
  console.log("Bergamot runtime + models (Remote Settings v2 collections)");
  const wasmRecs = ((await (await fetch(`${RS}/translations-wasm-v2/records`)).json()) as { data: WasmRecordV2[] }).data
    .filter((r) => r.name === "bergamot-translator")
    .sort((a, b) => Number.parseFloat(b.version) - Number.parseFloat(a.version));
  const w = wasmRecs[0];
  if (!w) throw new Error("no bergamot-translator wasm record");
  const dir = join(ROOT, "bergamot");
  await fetchZst(w.attachment, w.decompressedHash, join(dir, "bergamot-translator.wasm"));
  await fetchTo(GLUE_URL, join(dir, "bergamot-translator.js"), process.env.GLUE_COMMIT ? undefined : GLUE_SHA256);
  writeFileSync(join(dir, "runtime.json"), JSON.stringify({ release: w.release, recordVersion: w.version, sha256: w.decompressedHash, glue: GLUE_URL }, null, 2));

  const recs = ((await (await fetch(`${RS}/translations-models-v2/records`)).json()) as { data: ModelRecordV2[] }).data;
  for (const [src, tgt] of PAIRS) {
    const mine = recs.filter((r) => r.sourceLanguage === src && r.targetLanguage === tgt && desktopRecord(r.filter_expression) && !/a\d*$/.test(r.version));
    const best = mine.map((r) => r.version).sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a))[0];
    const files = mine.filter((r) => r.version === best);
    const pdir = join(dir, `${src}-${tgt}`);
    const manifest: Record<string, string> = {};
    for (const r of files) {
      await fetchZst(r.attachment, r.decompressedHash, join(pdir, r.name));
      manifest[r.fileType] = r.name;
    }
    writeFileSync(join(pdir, "pack.json"), JSON.stringify({ src, tgt, version: best, architecture: files[0]?.architecture, files: manifest }, null, 2));
  }
}

async function ocr(): Promise<void> {
  console.log("PP-OCRv5 ONNX (RapidOCR v3.10.0 on ModelScope)");
  for (const m of OCR) {
    await fetchTo(`${RAPID}/onnx/PP-OCRv5/${m.file}`, join(ROOT, "ocr", m.file), m.sha);
    if (m.dict) await fetchTo(`${RAPID}/paddle/PP-OCRv5/rec/${m.dict}`, join(ROOT, "ocr", "dict", m.dict.split("/")[1] ?? m.dict));
  }
}

// ---------------------------------------------------------------- M2M-100 418M (fallback check)
const M2M = "https://huggingface.co/Xenova/m2m100_418M/resolve/main";
async function m2m(): Promise<void> {
  console.log("M2M-100 418M int8 ONNX (Xenova/m2m100_418M)");
  for (const f of ["onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx", "tokenizer.json", "tokenizer_config.json", "config.json", "generation_config.json", "sentencepiece.bpe.model", "vocab.json"]) {
    await fetchTo(`${M2M}/${f}`, join(ROOT, "m2m100_418M", f));
  }
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  if (!args.has("--only-m2m")) {
    await ocr();
    await bergamot();
  }
  if (args.has("--m2m") || args.has("--only-m2m")) await m2m();
}
