// Bundle the inference Worker entries as their own files (GLIM-101). Electrobun bundles only
// the main entry (src/bun/index.ts); a `new Worker(new URL("./worker.ts", import.meta.url))`
// inside a dependency then points at a file that isn't in the app. So the preBuild hook
// builds each Worker here into dist/workers/, and electrobun.config.ts copies them next to
// the main bundle (<app>/bun/), where services/translation/bergamot-worker.ts finds them.
//
//   bun scripts/build-workers.ts      (also run by scripts/prebuild.ts)
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const workersOut = resolve(import.meta.dir, "..", "dist", "workers");

/** Worker entries: output file name -> source entry. */
export function workerEntries(): Record<string, string> {
	const bergamot = dirname(fileURLToPath(import.meta.resolve("@glimpse/providers/translation/bergamot")));
	return { "bergamot-worker.js": join(bergamot, "worker.ts") };
}

export async function buildWorkers(options: { readonly dev: boolean; readonly outDir?: string }): Promise<string[]> {
	const outDir = options.outDir ?? workersOut;
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	const built: string[] = [];
	for (const [name, entry] of Object.entries(workerEntries())) {
		const result = await Bun.build({
			entrypoints: [entry],
			target: "bun",
			format: "esm",
			outdir: outDir,
			naming: name,
			minify: !options.dev,
			sourcemap: options.dev ? "inline" : "none",
		});
		if (!result.success) {
			throw new AggregateError(result.logs, `could not bundle the ${name} Worker:\n${result.logs.join("\n")}`);
		}
		built.push(name);
	}
	return built;
}

if (import.meta.main) {
	const built = await buildWorkers({ dev: true });
	console.log(`workers: ${built.join(", ")} -> ${workersOut}`);
}
