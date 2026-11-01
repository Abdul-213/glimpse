// Run the PaddleOCR provider on PNG files from the dev model cache and print the lines.
//   bun scripts/ocr-cli.ts [--only=<recogniser>] [--lang=ja,de] <png>...
// `--only` hides every other recogniser (to compare recognisers on the same image).
import type { LanguageCode, ModelEntry, ModelFile, OcrRecognizer } from "@glimpse/core";
import { languageCode } from "@glimpse/core";
import { PaddleOcrProvider } from "../src/ocr/paddle/paddle-provider.ts";
import { cacheSource } from "../test/helpers/models.ts";
import { loadPng } from "../test/helpers/png.ts";

const args = process.argv.slice(2);
const flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const only = flag("only") as OcrRecognizer | undefined;
const languages: LanguageCode[] = (flag("lang") ?? "").split(",").filter(Boolean).map(languageCode);
const files = args.filter((a) => !a.startsWith("--"));

const models = only
	? {
			manifest: cacheSource.manifest,
			resolve: (m: ModelEntry, f: ModelFile) =>
				m.kind === "ocr-detector" || m.recognizer === only ? cacheSource.resolve(m, f) : null,
		}
	: cacheSource;
const grouping = args.includes("--lines") ? ("lines" as const) : ("blocks" as const);
const p = new PaddleOcrProvider({ threads: 2, grouping, ...(only ? { preload: [only] } : {}) }, { models });
console.log("init", (await p.init()).state);
for (const f of files) {
	const r = await p.recognise({ image: await loadPng(f), languages });
	console.log(`${f}: ${Math.round(p.lastTimings?.total ?? 0)} ms`, JSON.stringify(p.lastTimings));
	for (const b of r.blocks)
		console.log(
			`  ${b.id} [${b.confidence.toFixed(3)}] ${JSON.stringify(b.box)} ${b.writing ?? ""} ${JSON.stringify(b.text)}`,
		);
}
await p.dispose();
