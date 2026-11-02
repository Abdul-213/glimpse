// Bundle the inference Worker entries as their own files (GLIM-101, GLIM-103). Electrobun bundles
// only the main entry (src/bun/index.ts); a `new Worker(new URL("./worker.ts", import.meta.url))`
// inside a dependency then points at a file that isn't in the app. So the preBuild hook
// builds each Worker here into dist/workers/, and electrobun.config.ts copies them next to
// the main bundle (<app>/bun/), where services/translation/bergamot-worker.ts and
// services/ocr/paddle-worker.ts find them.
//
// The OCR Worker imports onnxruntime-node, whose binding.js loads its N-API addon with
// require(`../bin/napi-v6/${platform}/${arch}/onnxruntime_binding.node`): a path relative to
// the package that bundling can't follow. `ortBindingPlugin` rewrites it to the copy the build
// ships (<app>/native/onnxruntime/, staged by scripts/onnxruntime.ts), with an override.
//
//   bun scripts/build-workers.ts      (also run by scripts/prebuild.ts)
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";
import { OCR_WORKER_FILE } from "../src/bun/services/ocr/paddle-worker.ts";
import { BERGAMOT_WORKER_FILE } from "../src/bun/services/translation/bergamot-worker.ts";
import { ORT_BINDING } from "./onnxruntime.ts";

export const workersOut = resolve(import.meta.dir, "..", "dist", "workers");

/** The require in onnxruntime-node dist/binding.js (the same text in 1.31.1 and the pinned 1.23.2). */
export const ORT_BINDING_REQUIRE =
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal source text to replace
	"require(`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`)";

/**
 * Where the bundled OCR Worker loads the binding: `GLIMPSE_ORT_BINDING`, else
 * <worker dir>/../native/onnxruntime/onnxruntime_binding.node (the Worker sits in <app>/bun/).
 */
export const ORT_BINDING_RUNTIME = `require(process.env.GLIMPSE_ORT_BINDING || require("node:path").join(import.meta.dir, "..", "native", "onnxruntime", "${ORT_BINDING}"))`;

export const ortBindingPlugin: BunPlugin = {
	name: "glimpse-ort-binding",
	setup(build) {
		build.onLoad({ filter: /onnxruntime-node[\\/]dist[\\/]binding\.js$/ }, async (args) => {
			const source = await Bun.file(args.path).text();
			// Fail the build rather than ship a Worker that can't find its addon.
			if (!source.includes(ORT_BINDING_REQUIRE)) {
				throw new Error(`${args.path}: the binding require changed; update ortBindingPlugin`);
			}
			return { loader: "js", contents: source.replace(ORT_BINDING_REQUIRE, ORT_BINDING_RUNTIME) };
		});
	},
};

interface WorkerEntry {
	readonly entry: string;
	readonly plugins: readonly BunPlugin[];
}

/**
 * GLIM-89: bundle `onnxruntime-node` from another package folder (the pinned 1.23.2 for
 * darwin-x64, onnxruntime-legacy.ts). Its own `onnxruntime-common` resolves next to it.
 */
export function ortPackagePlugin(packageDir: string): BunPlugin {
	return {
		name: "glimpse-ort-package",
		setup(build) {
			build.onResolve({ filter: /^onnxruntime-node$/ }, () => ({ path: join(packageDir, "dist", "index.js") }));
		},
	};
}

/**
 * Worker entries: output file name -> source entry and bundler plugins. `ortPackageDir`: the
 * onnxruntime-node to bundle into the OCR Worker (default: the npm dependency).
 */
export function workerEntries(ortPackageDir?: string): Record<string, WorkerEntry> {
	const dirOf = (specifier: string) => dirname(fileURLToPath(import.meta.resolve(specifier)));
	return {
		[BERGAMOT_WORKER_FILE]: { entry: join(dirOf("@glimpse/providers/translation/bergamot"), "worker.ts"), plugins: [] },
		[OCR_WORKER_FILE]: {
			entry: join(dirOf("@glimpse/providers/ocr/paddle"), "worker.ts"),
			plugins: ortPackageDir ? [ortPackagePlugin(ortPackageDir), ortBindingPlugin] : [ortBindingPlugin],
		},
	};
}

export async function buildWorkers(options: {
	readonly dev: boolean;
	readonly outDir?: string;
	readonly ortPackageDir?: string;
}): Promise<string[]> {
	const outDir = options.outDir ?? workersOut;
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	const built: string[] = [];
	for (const [name, { entry, plugins }] of Object.entries(workerEntries(options.ortPackageDir))) {
		const result = await Bun.build({
			entrypoints: [entry],
			target: "bun",
			format: "esm",
			outdir: outDir,
			naming: name,
			minify: !options.dev,
			sourcemap: options.dev ? "inline" : "none",
			plugins: [...plugins],
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
