// Where the PaddleOCR inference Worker entry lives, and how to spawn it (GLIM-103). Same scheme
// as the Bergamot Worker (services/translation/bergamot-worker.ts, ARCHITECTURE.md section 3):
// the preBuild hook bundles packages/providers/src/ocr/paddle/worker.ts into
// dist/workers/ocr-worker.js, copied next to the main bundle (<app>/bun/ocr-worker.js). That
// bundle loads onnxruntime's native binding from <app>/native/onnxruntime/ (or
// GLIMPSE_ORT_BINDING), see scripts/build-workers.ts.
//
// Lookup order (like native/load.ts):
//   1. GLIMPSE_OCR_WORKER (absolute path; tests, debugging)
//   2. <dir>/ocr-worker.js: the bundled entry next to the main bundle
//   3. none: the provider's own default (source tree / `bun test`), which loads
//      onnxruntime-node from node_modules
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SpawnWorker, WorkerLike } from "@glimpse/providers/ocr/paddle";
import { disableOrtTelemetry } from "./ort-telemetry.ts";

export const OCR_WORKER_FILE = "ocr-worker.js";

/** The Worker entry to use, or null for the provider's default. Pure apart from `exists`. */
export function resolveOcrWorker(
	mainDir: string,
	env: Record<string, string | undefined> = process.env,
	exists: (path: string) => boolean = existsSync,
): string | null {
	const override = env["GLIMPSE_OCR_WORKER"];
	if (override) return resolve(override);
	const bundled = resolve(mainDir, OCR_WORKER_FILE);
	return exists(bundled) ? bundled : null;
}

/**
 * A spawner for `ctx.spawnWorker`, or undefined to keep the provider's default. Either way the
 * Worker runs in this process, so ONNX Runtime's telemetry is switched off here first (GLIM-112).
 */
export function ocrSpawner(
	mainDir: string,
	env: Record<string, string | undefined> = process.env,
	exists: (path: string) => boolean = existsSync,
	disableTelemetry: () => boolean = disableOrtTelemetry,
): { readonly spawn: SpawnWorker | undefined; readonly path: string | null } {
	disableTelemetry();
	const path = resolveOcrWorker(mainDir, env, exists);
	if (!path) return { spawn: undefined, path: null };
	return { spawn: () => new Worker(path) as unknown as WorkerLike, path };
}
