// Runs every benchmark case in a fresh Bun process and writes
// results/bench-<os>-<arch>-<date>.json plus a Markdown summary to stdout.
//   bun src/bench.ts            (default set, ~5-10 min on a laptop)
//   bun src/bench.ts --quick    (fewer iterations)
//   bun src/bench.ts --m2m      (also the M2M-100 fallback, needs `bun scripts/fetch-models.ts --m2m`)
import { mkdirSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem, platform, arch, release } from "node:os";
import { join } from "node:path";
import { MODELS, SAMPLES } from "./models";

const args = new Set(process.argv.slice(2));
const ITER = args.has("--quick") ? "5" : "15";
const S = (f: string) => join(SAMPLES, f);
const here = import.meta.dir;

interface CaseResult { argv: string[]; loadBefore: number; result: Record<string, unknown> | null; error?: string }

async function run(argv: string[], script = "bench-case.ts"): Promise<CaseResult> {
  const loadBefore = loadavg()[0] ?? 0;
  const p = Bun.spawn([process.execPath, join(here, script), ...argv], { env: { ...process.env, BENCH_ITER: ITER }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const line = out.trim().split("\n").pop() ?? "";
  try {
    return { argv, loadBefore, result: JSON.parse(line) as Record<string, unknown> };
  } catch {
    return { argv, loadBefore, result: null, error: (err || out).slice(-2000) };
  }
}

function dirSize(p: string): number {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((a, f) => a + (f.endsWith(".zst") ? 0 : dirSize(join(p, f))), 0);
}

const cases: string[][] = [
  ["ocr", "node", "4", "ch", S("region-ja.png"), S("region-zh.png"), S("region-en.png"), S("region-game-dark.png"), S("screen-1920x1080.png")],
  ["ocr", "node", "2", "ch", S("region-ja.png"), S("screen-1920x1080.png")],
  ["ocr", "node", "8", "ch", S("region-ja.png"), S("screen-1920x1080.png")],
  ["ocr", "web", "4", "ch", S("region-ja.png"), S("screen-1920x1080.png")],
  ["ocr", "web", "1", "ch", S("region-ja.png")],
  ["ocr", "node", "4", "en", S("region-en.png")],
  ["ocr", "node", "4", "latin", S("region-de.png")],
  ["ocr", "node", "4", "korean", S("region-ko.png"), S("screen-1920x1080.png")],
  ["ocr", "node", "4", "eslav", S("region-ru.png")],
  ["ocr", "node", "4", "cyrillic", S("region-ru.png")],
  ["ocr", "node", "4", "arabic", S("region-ar.png")],
  ["ocr", "node", "4", "devanagari", S("region-hi.png")],
  ["ocr", "node", "4", "th", S("region-th.png")],
  ["mt"],
  ["snip", "node", "4", "1", "0"],
  ["snip", "node", "4", "1", "1"],
  ["snip", "node", "4", "2", "1"],
];

const startedAt = new Date().toISOString();
const machine = { os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? "?", logicalCores: cpus().length, ramGB: Math.round(totalmem() / 2 ** 30), bun: Bun.version };
console.error(`machine: ${JSON.stringify(machine)}`);
const results: CaseResult[] = [];
for (const c of cases) {
  console.error(`> ${c.slice(0, 4).join(" ")}`);
  const r = await run(c);
  if (r.error) console.error(r.error);
  results.push(r);
}
if (args.has("--m2m")) {
  console.error("> m2m");
  const p = Bun.spawn([process.execPath, join(here, "m2m.ts")], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  results.push({ argv: ["m2m"], loadBefore: loadavg()[0] ?? 0, result: { case: "m2m", log: out.trim().split("\n") } });
}

const sizes: Record<string, number> = {};
for (const d of ["ocr/det", "ocr/rec", "bergamot/ja-en", "bergamot/zh-Hans-en", "bergamot/de-en", "bergamot/en-de", "m2m100_418M/onnx"]) {
  try {
    sizes[d] = Math.round(dirSize(join(MODELS, d)) / 1e5) / 10;
  } catch {
    /* not downloaded */
  }
}
for (const f of readdirSync(join(MODELS, "ocr", "rec"))) sizes[`rec/${f}`] = Math.round(statSync(join(MODELS, "ocr", "rec", f)).size / 1e5) / 10;

mkdirSync(join(here, "..", "results"), { recursive: true });
const file = join(here, "..", "results", `bench-${platform()}-${arch()}-${startedAt.slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify({ startedAt, machine, sizesMB: sizes, results }, null, 2));
console.error(`wrote ${file}`);

// ---- Markdown summary
const md: string[] = [];
const g = (o: unknown, ...path: string[]): unknown => path.reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o);
md.push(`Machine: ${machine.cpu}, ${machine.logicalCores} logical cores, ${machine.ramGB} GB, ${machine.os} ${machine.release} ${machine.arch}, Bun ${machine.bun}`);
md.push("", "| OCR case | load ms | first run ms | image | warm p50 / p90 / min ms | det / post / rec ms | lines | peak RSS MB |", "|---|---|---|---|---|---|---|---|");
for (const r of results.filter((x) => x.result?.case === "ocr")) {
  const res = r.result!;
  const per = res.perImage as Record<string, Record<string, number>>;
  for (const [img, s] of Object.entries(per)) {
    md.push(`| ${res.runtime} t=${res.threads} ${res.rec} | ${res.loadMs} | ${res.firstRunMs} | ${img} | ${s.p50} / ${s.p90} / ${s.min} | ${s.det} / ${s.detPost} / ${s.rec} | ${s.lines} | ${res.peakRssMB} |`);
  }
}
const mt = results.find((x) => x.result?.case === "mt")?.result;
if (mt) {
  md.push("", `Bergamot runtime init ${mt.runtimeMs} ms; pack load ms ${JSON.stringify(mt.packLoadMs)}; peak RSS ${mt.peakRssMB} MB (4 packs loaded)`);
  md.push("", "| Route | first call ms | per sentence p50 / p90 ms | batch of 5 p50 ms |", "|---|---|---|---|");
  for (const [k, v] of Object.entries(mt.routes as Record<string, unknown>)) md.push(`| ${k} | ${g(v, "firstCallMs")} | ${g(v, "perSentence", "p50")} / ${g(v, "perSentence", "p90")} | ${g(v, "batch5", "p50")} |`);
}
md.push("", "| Snip (600x200 ja, OCR + ja→en) | first snip ms (ocr+mt) | warm p50 / p90 / min | warm OCR p50 | warm MT p50 | peak RSS MB |", "|---|---|---|---|---|---|");
for (const r of results.filter((x) => x.result?.case === "snip")) {
  const s = r.result!;
  md.push(`| workers=${s.workers} prewarm=${s.prewarm} | ${g(s, "firstSnip", "total")} (${g(s, "firstSnip", "ocr")}+${g(s, "firstSnip", "mt")}) | ${g(s, "warm", "p50")} / ${g(s, "warm", "p90")} / ${g(s, "warm", "min")} | ${g(s, "warmOcr", "p50")} | ${g(s, "warmMt", "p50")} | ${s.peakRssMB} |`);
}
md.push("", `Load average before cases: ${results.map((r) => r.loadBefore.toFixed(1)).join(", ")}`);
md.push("", `Model sizes on disk (MB): ${JSON.stringify(sizes)}`);
console.log(md.join("\n"));
