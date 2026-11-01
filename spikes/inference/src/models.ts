// Paths to downloaded models and PNG loading (dev-only; the app captures raw pixels).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { RgbaImage } from "./ocr/image";

export const MODELS = join(import.meta.dir, "..", "models");
export const SAMPLES = join(import.meta.dir, "..", "samples");
export const DET = join(MODELS, "ocr", "det", "ch_PP-OCRv5_det_mobile.onnx");

/** Recogniser per script family. `ch` covers Simplified/Traditional Chinese, Japanese and English. */
export const REC: Record<string, { model: string; dict: string }> = {
  ch: { model: "ch_PP-OCRv5_rec_mobile.onnx", dict: "ppocrv5_dict.txt" },
  korean: { model: "korean_PP-OCRv5_rec_mobile.onnx", dict: "ppocrv5_korean_dict.txt" },
  latin: { model: "latin_PP-OCRv5_rec_mobile.onnx", dict: "ppocrv5_latin_dict.txt" },
  en: { model: "en_PP-OCRv5_rec_mobile.onnx", dict: "ppocrv5_en_dict.txt" },
  eslav: { model: "eslav_PP-OCRv5_rec_mobile.onnx", dict: "ppocrv5_eslav_dict.txt" },
  cyrillic: { model: "cyrillic_PP-OCRv5_rec_mobile.onnx", dict: "ppocrv5_cyrillic_dict.txt" },
  arabic: { model: "arabic_PP-OCRv5_rec_mobile.onnx", dict: "ppocrv5_arabic_dict.txt" },
  devanagari: { model: "devanagari_PP-OCRv5_rec_mobile.onnx", dict: "ppocrv5_devanagari_dict.txt" },
  th: { model: "th_PP-OCRv5_rec_mobile.onnx", dict: "ppocrv5_th_dict.txt" },
  el: { model: "el_PP-OCRv5_rec_mobile.onnx", dict: "ppocrv5_el_dict.txt" },
};

export function recPaths(name: string): { model: string; dict: string } {
  const r = REC[name];
  if (!r) throw new Error(`unknown rec model ${name}; one of ${Object.keys(REC).join(", ")}`);
  return { model: join(MODELS, "ocr", "rec", r.model), dict: join(MODELS, "ocr", "dict", r.dict) };
}

export function loadPng(path: string): RgbaImage {
  const p = PNG.sync.read(readFileSync(path));
  return { width: p.width, height: p.height, data: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength) };
}
