// Real-model checks. Skipped unless `bun scripts/fetch-models.ts` and
// `bun scripts/make-samples.ts` have been run.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import { loadPack, loadRuntime, Translator } from "../src/bergamot";
import { DET, loadPng, MODELS, recPaths, SAMPLES } from "../src/models";
import { OcrEngine, type OrtLike } from "../src/ocr/pipeline";

const haveOcr = existsSync(DET) && existsSync(join(SAMPLES, "region-en.png"));
const haveMt = existsSync(join(MODELS, "bergamot", "de-en", "pack.json"));

test.skipIf(!haveOcr)("PP-OCRv5 reads the rendered English and Japanese regions", async () => {
  const { model, dict } = recPaths("ch");
  const engine = await OcrEngine.create(ort as unknown as OrtLike, DET, model, dict, { intraOpNumThreads: 2 });
  const en = await engine.run(loadPng(join(SAMPLES, "region-en.png")));
  expect(en.lines.map((l) => l.text)).toContain("Settings saved successfully.");
  const ja = await engine.run(loadPng(join(SAMPLES, "region-ja.png")));
  expect(ja.lines.map((l) => l.text)).toContain("明日の会議は午後三時に始まります。");
}, 60_000);

test.skipIf(!haveMt)("Bergamot translates de->en in-process", async () => {
  const dir = join(MODELS, "bergamot");
  const { mod } = await loadRuntime(dir);
  const { model } = loadPack(mod, join(dir, "de-en"));
  const out = new Translator(mod).translate(["Die Datei konnte nicht gespeichert werden."], model);
  expect(out[0]).toBe("The file could not be saved.");
}, 60_000);
