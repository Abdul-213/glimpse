// Latency of the PaddleOCR provider (worker round trip included), from the dev model cache.
//   bun scripts/bench-ocr.ts [--iter=15] [--threads=N]
// Prints a markdown table. Live rows (GLIM-88) re-run a 5-line region where 0, 1 or 5 lines
// change each frame (a few pixels inside the line are altered), with the rec cache on.
import { join } from "node:path";
import { languageCode, type OcrImage, type Rect } from "@glimpse/core";
import { PaddleOcrProvider } from "../src/ocr/paddle/paddle-provider.ts";
import { cacheSource, FIXTURES } from "../test/helpers/models.ts";
import { loadPng } from "../test/helpers/png.ts";

const args = process.argv.slice(2);
const flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const ITER = Number(flag("iter") ?? 15);
const threads = Number(flag("threads") ?? 0);

const stats = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
	return { p50: q(0.5), p90: q(0.9), min: s[0] ?? 0 };
};
const fmt = (n: number) => Math.round(n).toString();

const rows: string[] = [];
const row = (...cells: string[]) => rows.push(`| ${cells.join(" | ")} |`);

const t0 = performance.now();
const make = (cache: number) => new PaddleOcrProvider({ threads, recCacheSize: cache }, { models: cacheSource });
const p = make(0);
await p.init();
const initMs = performance.now() - t0;
const tw = performance.now();
await p.warmup();
const warmMs = performance.now() - tw;

async function bench(label: string, provider: PaddleOcrProvider, img: OcrImage, langs: string[], note = "") {
	const languages = langs.map(languageCode);
	const ft = performance.now();
	const first = await provider.recognise({ image: img, languages });
	const firstMs = performance.now() - ft;
	const totals: number[] = [];
	const det: number[] = [];
	const rec: number[] = [];
	for (let i = 0; i < ITER; i++) {
		await provider.recognise({ image: img, languages });
		const t = provider.lastTimings;
		if (!t) continue;
		totals.push(t.total);
		det.push(t.det + t.detPost);
		rec.push(t.rec);
	}
	const s = stats(totals);
	row(
		label,
		`${img.width}x${img.height}`,
		String(first.blocks.length),
		fmt(firstMs),
		`**${fmt(s.p50)}**`,
		fmt(s.min),
		fmt(s.p90),
		`${fmt(stats(det).p50)} / ${fmt(stats(rec).p50)}`,
		note,
	);
}

const png = (n: string) => loadPng(join(FIXTURES, n));
row("Case", "Size", "Lines", "First call", "Warm p50", "min", "p90", "det / rec p50", "Notes");
row("---", "---", "---", "---", "---", "---", "---", "---", "---");
await bench("en region, `ch` only", p, await png("region-en.png"), ["en"], "subset {en}: ch reads it");
await bench("ja region", p, await png("region-ja.png"), ["ja"]);
await bench("zh region", p, await png("region-zh.png"), ["zh-Hans"]);
await bench("de region, subset {de}", p, await png("region-de.png"), ["de"], "latin only");
await bench("de region, subset {ja, de}", p, await png("region-de.png"), ["ja", "de"], "ch, then latin re-read");
await bench("dark game dialogue (ja)", p, await png("region-game-dark.png"), ["ja"]);
await bench("1920x1080 screenshot", p, await png("screen-1920x1080.png"), ["ja", "zh-Hans", "de", "en"], "");
await p.dispose();

// GLIM-88: Live frames over the same 5-line region with k lines changing every frame.
const live = make(512);
await live.init();
await live.warmup();
const base = await png("region-en.png");
const lines = (await live.recognise({ image: base, languages: [languageCode("en")] })).blocks.map((b) => b.box);
for (const k of [0, 1, 5]) {
	const totals: number[] = [];
	const recRuns: number[] = [];
	for (let i = 0; i < ITER + 1; i++) {
		const frame = { ...base, data: base.data.slice() };
		for (const box of lines.slice(0, k)) tweak(frame, box, i);
		await live.recognise({ image: frame, languages: [languageCode("en")] });
		if (i === 0) continue; // the first frame fills the cache
		totals.push(live.lastTimings?.total ?? 0);
		recRuns.push(live.lastTimings?.recRuns ?? 0);
	}
	const s = stats(totals);
	row(
		`Live, ${k} of 5 lines changed`,
		`${base.width}x${base.height}`,
		"5",
		"",
		`**${fmt(s.p50)}**`,
		fmt(s.min),
		fmt(s.p90),
		"",
		`rec cache on; ${Math.round(stats(recRuns).p50)} rec runs/frame`,
	);
}
await live.dispose();

/** Change a few pixels near the left end of a line (a "different character"). */
function tweak(img: OcrImage, box: Rect, seed: number) {
	const y = box.y + Math.floor(box.height / 2);
	for (let dx = 0; dx < 3; dx++) {
		const o = y * img.stride + (box.x + 6 + dx) * 4;
		img.data.fill((seed * 37 + dx * 11) % 200, o, o + 3);
	}
}

console.log(`init (det + ch + latin sessions, worker start): ${fmt(initMs)} ms; warmup ${fmt(warmMs)} ms`);
console.log(`threads: ${threads || "auto"}, iterations: ${ITER}\n`);
console.log(rows.join("\n"));
console.log(`\npeak RSS (main): ${Math.round(process.resourceUsage().maxRSS / 1024)} MB (includes the worker thread)`);
