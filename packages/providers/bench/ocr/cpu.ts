// GLIM-134: CPU and wall time per OCR run for ORT thread counts, with spinning on and off.
//
//   bun packages/providers/bench/ocr/cpu.ts [--iter=3] [--threads=1,2,4] [--only=<id substring>]
//
// Runs the GLIM-64 corpus through PaddleOcrProvider (rec cache off) once per configuration and
// prints a markdown table: process CPU (user + system, all threads, so the OCR Worker's ORT
// threads are included) per run, and the p50 / summed wall time per run. Configurations are
// interleaved round by round so a noisy machine skews them all alike.

import { cpus } from "node:os";
import { join } from "node:path";
import { languageCode } from "@glimpse/core";
import { PaddleOcrProvider } from "../../src/ocr/paddle/paddle-provider.ts";
import { cacheSource } from "../../test/helpers/models.ts";
import { loadPng } from "../../test/helpers/png.ts";
import { type Corpus, percentile } from "./metrics.ts";

const DIR = import.meta.dir;
const args = process.argv.slice(2);
const flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const ITER = Number(flag("iter") ?? 3);
const ROUNDS = Number(flag("rounds") ?? 2);
const threadList = (flag("threads") ?? "1,2,4").split(",").map(Number);
const only = flag("only");

const corpus = (await Bun.file(join(DIR, "corpus.json")).json()) as Corpus;
const cases = await Promise.all(
	corpus.cases
		.filter((c) => !only || c.id.includes(only))
		.map(async (c) => ({ id: c.id, image: await loadPng(join(DIR, c.image)), languages: c.sources.map(languageCode) })),
);

const cpuMs = () => {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1000;
};

interface Config {
	readonly threads: number;
	readonly spinning: boolean;
	readonly ocr: PaddleOcrProvider;
	cpu: number;
	runs: number[];
}
const configs: Config[] = [];
for (const threads of threadList) {
	for (const spinning of [true, false]) {
		const ocr = new PaddleOcrProvider({ threads, spinning, recCacheSize: 0 }, { models: cacheSource });
		const s = await ocr.init();
		if (s.state !== "ready") throw new Error(`PaddleOCR not ready (${s.state}); run \`bun run models -- --all\``);
		await ocr.warmup();
		// Load every recogniser the corpus needs before measuring.
		for (const c of cases) await ocr.recognise({ image: c.image, languages: c.languages });
		configs.push({ threads, spinning, ocr, cpu: 0, runs: [] });
	}
}

for (let round = 0; round < ROUNDS; round++) {
	for (const cfg of configs) {
		for (const c of cases) {
			for (let i = 0; i < ITER; i++) {
				const c0 = cpuMs();
				const t0 = performance.now();
				await cfg.ocr.recognise({ image: c.image, languages: c.languages });
				cfg.runs.push(performance.now() - t0);
				cfg.cpu += cpuMs() - c0;
			}
		}
	}
}
for (const cfg of configs) await cfg.ocr.dispose();

const n = cases.length * ITER * ROUNDS;
console.log(
	`Machine: ${cpus()[0]?.model.trim()}, ${cpus().length} cores; ${cases.length} cases x ${ITER} x ${ROUNDS} rounds\n`,
);
console.log("| ORT threads | Spinning | CPU per run (mean) | Wall per run p50 | Wall per run mean | CPU / wall |");
console.log("|---|---|---|---|---|---|");
for (const cfg of configs) {
	const wall = cfg.runs.reduce((a, b) => a + b, 0);
	console.log(
		`| ${cfg.threads} | ${cfg.spinning ? "on" : "off"} | ${(cfg.cpu / n).toFixed(0)} ms | ${percentile(cfg.runs, 0.5).toFixed(0)} ms | ${(wall / n).toFixed(0)} ms | ${(cfg.cpu / wall).toFixed(2)} |`,
	);
}
