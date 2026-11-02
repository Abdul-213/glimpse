// GLIM-64: OCR accuracy and latency benchmark over the corpus in this folder.
//
//   bun run bench:ocr [--iter=5] [--only=<id substring>] [--threads=N]
//                     [--report=<file.md>] [--json=<file.json>]
//                     [--check] [--no-latency-gate] [--write-baseline]
//
// PaddleOCR (the default local engine) runs exactly as Snip calls it: default options, the
// case's source subset as `languages`, its own GLIM-56 grouping, then the app's GLIM-21
// detector over ELD. The rec cache is off so repeated runs measure real work, not cache hits.
// Models come from the dev cache (`bun run models -- --all`; on-demand recognisers included).
//
// --check compares with baseline.json and exits 1 on a large regression (metrics.ts
// THRESHOLDS); a case whose recognisers aren't installed also fails it. --write-baseline
// stores this run as the new baseline.
import { cpus, platform, release } from "node:os";
import { join } from "node:path";
import { glim21Detector, languageCode, type OcrBlock } from "@glimpse/core";
import { loadEldDetector } from "../../src/language-detect/eld.ts";
import { PaddleOcrProvider } from "../../src/ocr/paddle/paddle-provider.ts";
import { cacheSource } from "../../test/helpers/models.ts";
import { loadPng } from "../../test/helpers/png.ts";
import {
	type Baseline,
	type CaseResult,
	type Corpus,
	percentile,
	regressions,
	type Summary,
	scoreCase,
	summariseAll,
	THRESHOLDS,
	toBaseline,
} from "./metrics.ts";
import { renderReport } from "./report.ts";

const DIR = import.meta.dir;
const args = process.argv.slice(2);
const flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const has = (k: string) => args.includes(`--${k}`);
const ITER = Number(flag("iter") ?? 5);
const threads = Number(flag("threads") ?? 0);
const only = flag("only");

const corpus = (await Bun.file(join(DIR, "corpus.json")).json()) as Corpus;
const cases = corpus.cases.filter((c) => !only || c.id.includes(only));

const ocr = new PaddleOcrProvider({ threads, recCacheSize: 0 }, { models: cacheSource });
const tInit = performance.now();
const status = await ocr.init();
if (status.state !== "ready") {
	console.error(`PaddleOCR is not ready (${status.state}). Run \`bun run models -- --all\` first.`);
	process.exit(1);
}
const initMs = performance.now() - tInit;
const tWarm = performance.now();
await ocr.warmup();
const warmupMs = performance.now() - tWarm;
const detector = glim21Detector({ detectors: [await loadEldDetector()] });

const results: CaseResult[] = [];
const skipped: string[] = [];
for (const c of cases) {
	const languages = c.sources.map(languageCode);
	const missing = languages.filter((l) => ocr.languageSupport(l).status !== "ready");
	// A subset language that can't be read isn't fatal for the app (it just isn't OCR'd), but
	// here it means the benchmark can't run the case as written.
	if (missing.some((l) => c.blocks.some((b) => b.lang === l))) {
		skipped.push(`${c.id} (recogniser missing for ${missing.join(", ")})`);
		continue;
	}
	const image = await loadPng(join(DIR, c.image));
	const t0 = performance.now();
	let blocks: readonly OcrBlock[] = (await ocr.recognise({ image, languages })).blocks;
	const firstMs = performance.now() - t0;
	const runs: number[] = [];
	for (let i = 0; i < ITER; i++) {
		const t = performance.now();
		blocks = (await ocr.recognise({ image, languages })).blocks;
		runs.push(performance.now() - t);
	}
	const decided = await detector.detect(blocks, { sources: languages, target: languageCode("en"), mode: "snip" });
	const score = scoreCase(c, blocks, decided);
	results.push({ id: c.id, script: c.script, kind: c.kind, score, firstMs, runs });
	console.log(
		`${c.id.padEnd(30)} CER ${(score.cer * 100).toFixed(1).padStart(5)}%  blocks ${score.blocks.exact}/${score.blocks.truth}  ` +
			`lang ${score.detection.correct}/${score.detection.total}  p50 ${Math.round(percentile(runs, 0.5))} ms`,
	);
}
await ocr.dispose();

const summary: Summary = summariseAll(results);
const cpu = cpus()[0]?.model.trim() ?? "unknown CPU";
const machine = `${cpu}, ${cpus().length} cores, ${platform()} ${release()}, ORT threads ${threads || "auto"}`;
const report = renderReport({ summary, results, skipped, machine, initMs, warmupMs, iterations: ITER, corpus });

const reportPath = flag("report");
if (reportPath) await Bun.write(reportPath, report);
else console.log(`\n${report}`);
const jsonPath = flag("json");
if (jsonPath) await Bun.write(jsonPath, `${JSON.stringify({ machine, summary, results, skipped }, null, "\t")}\n`);

const baselinePath = join(DIR, "baseline.json");
if (has("write-baseline")) {
	await Bun.write(baselinePath, `${JSON.stringify(toBaseline(summary, machine), null, "\t")}\n`);
	console.log(`wrote ${baselinePath}`);
}
if (has("check")) {
	const baseline = (await Bun.file(baselinePath).json()) as Baseline;
	const found = regressions(summary, baseline, THRESHOLDS, { latency: !has("no-latency-gate") });
	if (skipped.length > 0) found.push(`cases skipped: ${skipped.join("; ")}`);
	if (found.length > 0) {
		console.error(`\nOCR benchmark: ${found.length} large regression(s) against baseline.json:`);
		for (const f of found) console.error(`  - ${f}`);
		process.exit(1);
	}
	console.log(`\nOCR benchmark: no large regressions against baseline.json (${baseline.machine}).`);
}
