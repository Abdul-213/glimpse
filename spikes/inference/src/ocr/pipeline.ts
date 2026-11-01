// End-to-end OCR: det -> crop -> rec, over any ONNX Runtime JS binding
// (onnxruntime-node or onnxruntime-web share the same InferenceSession/Tensor API).
import { readFileSync } from "node:fs";
import { DB_DEFAULTS, type Box, DET_MEAN, DET_STD, type DbOptions, type DetSizeOptions, dbPostprocess, detInputSize } from "./det";
import { type RgbaImage, resizeNormalizeBGR } from "./image";
import { buildCharset, ctcDecode, cropQuad, recBatch, recWidth, visualToLogicalRtl } from "./rec";

// Structural subset of onnxruntime-common we use, so both packages fit.
export interface OrtTensor { data: unknown; dims: readonly number[] }
export interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}
export interface OrtLike {
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => OrtTensor;
  InferenceSession: { create(model: string | Uint8Array, opts?: object): Promise<OrtSession> };
}

export interface OcrLine extends Box {
  text: string;
  textScore: number;
}

export interface OcrTimings { det: number; detPost: number; rec: number; total: number; lines: number }

export interface OcrOptions {
  det: DetSizeOptions;
  db: DbOptions;
  recMaxWidth: number;
  recBatch: number;
  /** Round rec tensor widths up to a multiple of this (fewer distinct shapes for ORT). */
  recBucket: number;
  minTextScore: number;
  /** Recogniser emits right-to-left scripts in visual order (Arabic): reverse to logical. */
  rtl: boolean;
}
export const OCR_DEFAULTS: OcrOptions = {
  det: { maxSide: 1920, minSide: 0 },
  db: DB_DEFAULTS,
  recMaxWidth: 3200,
  recBatch: 8,
  recBucket: 1,
  minTextScore: 0.5,
  rtl: false,
};

export class OcrEngine {
  private constructor(
    private ort: OrtLike,
    private det: OrtSession,
    private rec: OrtSession,
    private charset: string[],
    readonly opts: OcrOptions,
  ) {}

  static async create(ort: OrtLike, detPath: string, recPath: string, dictPath: string, sessionOpts: object, opts: Partial<OcrOptions> = {}): Promise<OcrEngine> {
    // onnxruntime-web can't read paths in Bun; hand it bytes. Node accepts both.
    const load = (p: string) => new Uint8Array(readFileSync(p));
    const [det, rec] = await Promise.all([ort.InferenceSession.create(load(detPath), sessionOpts), ort.InferenceSession.create(load(recPath), sessionOpts)]);
    return new OcrEngine(ort, det, rec, buildCharset(readFileSync(dictPath, "utf8")), { ...OCR_DEFAULTS, ...opts });
  }

  async detect(img: RgbaImage, t?: OcrTimings): Promise<Box[]> {
    const s = detInputSize(img.width, img.height, this.opts.det);
    const t0 = performance.now();
    const input = resizeNormalizeBGR(img, s.w, s.h, DET_MEAN, DET_STD);
    const out = await this.det.run({ [this.det.inputNames[0]!]: new this.ort.Tensor("float32", input, [1, 3, s.h, s.w]) });
    const t1 = performance.now();
    const prob = out[this.det.outputNames[0]!]!.data as Float32Array;
    const boxes = dbPostprocess(prob, s.w, s.h, img.width, img.height, this.opts.db);
    if (t) {
      t.det += t1 - t0;
      t.detPost += performance.now() - t1;
    }
    return boxes;
  }

  async recognize(img: RgbaImage, boxes: Box[], t?: OcrTimings): Promise<OcrLine[]> {
    const t0 = performance.now();
    const crops = boxes.map((b) => cropQuad(img, b.quad));
    // Sort by aspect ratio so each batch pads little (PaddleOCR does the same).
    const order = crops.map((_, i) => i).sort((a, b) => recWidth(crops[a]!.width, crops[a]!.height, 1e9) - recWidth(crops[b]!.width, crops[b]!.height, 1e9));
    const results: OcrLine[] = new Array(boxes.length);
    for (let i = 0; i < order.length; i += this.opts.recBatch) {
      const idx = order.slice(i, i + this.opts.recBatch);
      const { data, width } = recBatch(idx.map((k) => crops[k]!), this.opts.recMaxWidth, this.opts.recBucket);
      const out = await this.rec.run({ [this.rec.inputNames[0]!]: new this.ort.Tensor("float32", data, [idx.length, 3, 48, width]) });
      const o = out[this.rec.outputNames[0]!]!;
      const [, T, C] = o.dims as [number, number, number];
      const probs = o.data as Float32Array;
      idx.forEach((k, j) => {
        const r = ctcDecode(probs, T, C, this.charset, j * T * C);
        results[k] = { ...boxes[k]!, text: this.opts.rtl ? visualToLogicalRtl(r.text) : r.text, textScore: r.score };
      });
    }
    if (t) t.rec += performance.now() - t0;
    return results.filter((r) => r.textScore >= this.opts.minTextScore && r.text.trim() !== "");
  }

  async run(img: RgbaImage): Promise<{ lines: OcrLine[]; timings: OcrTimings }> {
    const t: OcrTimings = { det: 0, detPost: 0, rec: 0, total: 0, lines: 0 };
    const t0 = performance.now();
    const boxes = await this.detect(img, t);
    const lines = await this.recognize(img, boxes, t);
    t.total = performance.now() - t0;
    t.lines = lines.length;
    return { lines, timings: t };
  }
}
