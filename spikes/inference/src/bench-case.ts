// One benchmark case in a fresh process (so cold numbers and peak RSS are honest).
// Prints one JSON line. Driven by src/bench.ts; can be run by hand:
//   bun src/bench-case.ts ocr node 4 ch samples/region-ja.png
//   bun src/bench-case.ts mt worker
//   bun src/bench-case.ts snip node 4
import { join } from "node:path";
import { loadPack, loadRuntime, Translator } from "./bergamot";
import { DET, loadPng, MODELS, recPaths, SAMPLES } from "./models";
import { OcrEngine, type OrtLike } from "./ocr/pipeline";
import { stats, type Stats } from "./stats";

const ITER = Number(process.env.BENCH_ITER ?? 15);
const BERGAMOT = join(MODELS, "bergamot");

function peakRssMB(): number {
  // maxRSS is KiB on Linux/macOS/Windows in Bun's resourceUsage
  return Math.round(process.resourceUsage().maxRSS / 1024);
}

async function ort(runtime: string, threads: number): Promise<{ ort: OrtLike; sessionOpts: object }> {
  if (runtime === "web") {
    const m = await import("onnxruntime-web");
    m.env.wasm.numThreads = threads;
    return { ort: m as unknown as OrtLike, sessionOpts: { executionProviders: ["wasm"] } };
  }
  const m = await import("onnxruntime-node");
  return { ort: m as unknown as OrtLike, sessionOpts: { intraOpNumThreads: threads, interOpNumThreads: 1 } };
}

async function warm(fn: () => Promise<unknown>): Promise<Stats> {
  await fn();
  const xs: number[] = [];
  for (let i = 0; i < ITER; i++) {
    const t = performance.now();
    await fn();
    xs.push(performance.now() - t);
  }
  return stats(xs);
}

async function ocrCase(runtime: string, threads: number, rec: string, images: string[]): Promise<object> {
  const t0 = performance.now();
  const { ort: o, sessionOpts } = await ort(runtime, threads);
  const { model, dict } = recPaths(rec);
  const engine = await OcrEngine.create(o, DET, model, dict, sessionOpts, { rtl: rec === "arabic" });
  const loadMs = performance.now() - t0;
  const imgs = images.map((p) => ({ p, img: loadPng(p) }));
  const firstT = performance.now();
  const first = await engine.run(imgs[0]!.img);
  const firstRunMs = performance.now() - firstT;
  const coldToFirstResult = performance.now(); // since process start
  const perImage: Record<string, object> = {};
  for (const { p, img } of imgs) {
    const s = await warm(() => engine.run(img));
    const r = await engine.run(img);
    perImage[p.split("/").pop()!] = { ...s, lines: r.lines.length, det: Math.round(r.timings.det), detPost: Math.round(r.timings.detPost), rec: Math.round(r.timings.rec), text: r.lines.map((l) => l.text) };
  }
  return { case: "ocr", runtime, threads, rec, loadMs: Math.round(loadMs), firstRunMs: Math.round(firstRunMs), firstLines: first.lines.length, coldToFirstResultMs: Math.round(coldToFirstResult), perImage, peakRssMB: peakRssMB() };
}

const SENTENCES: Record<string, string[]> = {
  "ja-en": ["設定を保存しました。", "このアイテムを使用しますか？", "明日の会議は午後三時に始まります。", "勇者よ、よくぞ来た！この先は危険な森だ。", "ダウンロードが完了しました"],
  "zh-Hans-en": ["你好，世界！", "请输入您的密码。", "这个游戏的剧情非常精彩。", "下载已完成，请重新启动。", "已经下载好了，谢谢提醒。"],
  "de-en": ["Einstellungen", "Die Datei konnte nicht gespeichert werden.", "Möchten Sie die Änderungen übernehmen?", "Wir sehen uns morgen am Bahnhof.", "Vergiss nicht, das Update zu installieren."],
  "en-de": ["Settings", "The file could not be saved.", "Do you want to install the update now?", "See you tomorrow at the station.", "We have to leave before the storm arrives."],
};

async function mtCase(): Promise<object> {
  const t0 = performance.now();
  const { mod } = await loadRuntime(BERGAMOT);
  const runtimeMs = performance.now() - t0;
  const loads: Record<string, number> = {};
  const models: Record<string, ReturnType<typeof loadPack>["model"]> = {};
  for (const p of Object.keys(SENTENCES)) {
    const t = performance.now();
    models[p] = loadPack(mod, join(BERGAMOT, p)).model;
    loads[p] = Math.round(performance.now() - t);
  }
  const tr = new Translator(mod);
  const routes: [string, string, string | undefined][] = [
    ["ja→en", "ja-en", undefined],
    ["zh→en", "zh-Hans-en", undefined],
    ["de→en", "de-en", undefined],
    ["en→de", "en-de", undefined],
    ["ja→en→de", "ja-en", "en-de"],
  ];
  const out: Record<string, object> = {};
  for (const [label, a, b] of routes) {
    const ss = SENTENCES[a]!;
    const ma = models[a]!;
    const mb = b ? models[b] : undefined;
    const firstT = performance.now();
    tr.translate([ss[0]!], ma, mb);
    const first = performance.now() - firstT;
    let i = 0;
    const perSentence = await warm(async () => tr.translate([ss[i++ % ss.length]!], ma, mb));
    const batch = await warm(async () => tr.translate(ss, ma, mb));
    out[label] = { firstCallMs: Math.round(first), perSentence, batch5: batch, sample: tr.translate(ss, ma, mb).map((t, k) => `${ss[k]} -> ${t}`) };
  }
  return { case: "mt", runtimeMs: Math.round(runtimeMs), packLoadMs: loads, routes: out, peakRssMB: peakRssMB() };
}

/** A Bergamot Worker for one route, with a promise API. */
function mtWorker(packs: string[]): { ready: Promise<number>; translate: (texts: string[]) => Promise<string[]>; terminate: () => void } {
  const worker = new Worker(new URL("./bergamot-worker.ts", import.meta.url).href);
  let nextId = 0;
  const pending = new Map<number, (t: string[]) => void>();
  let readyResolve: (ms: number) => void = () => undefined;
  const ready = new Promise<number>((r) => (readyResolve = r));
  worker.onmessage = (e: MessageEvent<{ type: string; id?: number; texts?: string[]; ms?: number; error?: string }>) => {
    const m = e.data;
    if (m.type === "ready") readyResolve(m.ms ?? 0);
    else if (m.type === "result") pending.get(m.id!)?.(m.texts ?? []);
    else if (m.type === "error") throw new Error(m.error);
  };
  worker.postMessage({ type: "init", dir: BERGAMOT, packs });
  const translate = (texts: string[]) =>
    new Promise<string[]>((res) => {
      const id = nextId++;
      pending.set(id, res);
      worker.postMessage({ type: "translate", id, texts, route: packs });
    });
  return { ready, translate, terminate: () => worker.terminate() };
}

/**
 * Snip: OCR a 600x200 ja region, translate its lines ja->en with Bergamot in
 * `workers` Bun Workers (lines split round-robin). `prewarm` sends one dummy
 * sentence at start-up, which absorbs Bergamot's slow first call.
 */
async function snipCase(runtime: string, threads: number, workers: number, prewarm: boolean): Promise<object> {
  const pool = Array.from({ length: workers }, () => mtWorker(["ja-en"]));
  const { ort: o, sessionOpts } = await ort(runtime, threads);
  const { model, dict } = recPaths("ch");
  const engine = await OcrEngine.create(o, DET, model, dict, sessionOpts);
  const mtReadyMs = Math.max(...(await Promise.all(pool.map((w) => w.ready))));
  if (prewarm) await Promise.all(pool.map((w) => w.translate(["準備"])));
  const readyAt = performance.now();
  const img = loadPng(join(SAMPLES, "region-ja.png"));
  const translate = async (lines: string[]) => {
    const parts = pool.map((_, k) => lines.filter((_, i) => i % workers === k));
    const res = await Promise.all(pool.map((w, k) => (parts[k]!.length ? w.translate(parts[k]!) : Promise.resolve([]))));
    return lines.map((_, i) => res[i % workers]![Math.floor(i / workers)]!);
  };
  const timing = { ocr: 0, mt: 0 };
  const snip = async () => {
    const t0 = performance.now();
    const r = await engine.run(img);
    const t1 = performance.now();
    const out = await translate(r.lines.map((l) => l.text));
    timing.ocr = t1 - t0;
    timing.mt = performance.now() - t1;
    return out;
  };
  const firstT = performance.now();
  const firstOut = await snip();
  const first = { total: Math.round(performance.now() - firstT), ocr: Math.round(timing.ocr), mt: Math.round(timing.mt) };
  const cold = performance.now();
  const ocrXs: number[] = [];
  const mtXs: number[] = [];
  const s = await warm(async () => {
    await snip();
    ocrXs.push(timing.ocr);
    mtXs.push(timing.mt);
  });
  for (const w of pool) w.terminate();
  return {
    case: "snip", runtime, threads, workers, prewarm, mtWorkerInitMs: Math.round(mtReadyMs), readyAtMs: Math.round(readyAt),
    firstSnip: first, coldToFirstSnipMs: Math.round(cold), warm: s, warmOcr: stats(ocrXs.slice(1)), warmMt: stats(mtXs.slice(1)),
    output: firstOut, peakRssMB: peakRssMB(),
  };
}

const [kind, ...rest] = process.argv.slice(2);
let result: object;
if (kind === "ocr") {
  const [runtime = "node", threads = "4", rec = "ch", ...imgs] = rest;
  result = await ocrCase(runtime, Number(threads), rec, imgs.length ? imgs : [join(SAMPLES, "region-ja.png")]);
} else if (kind === "mt") {
  result = await mtCase();
} else if (kind === "snip") {
  const [runtime = "node", threads = "4", workers = "1", prewarm = "1"] = rest;
  result = await snipCase(runtime, Number(threads), Number(workers), prewarm === "1");
} else throw new Error("usage: bench-case.ts ocr|mt|snip ...");
console.log(JSON.stringify(result));
process.exit(0);
