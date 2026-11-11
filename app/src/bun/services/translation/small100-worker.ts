// Where the SMaLL-100 inference Worker entry lives, and how to spawn it (GLIM-100). Same scheme
// as the PaddleOCR Worker (services/ocr/paddle-worker.ts, GLIM-103): the preBuild hook bundles
// packages/providers/src/translation/small100/worker.ts into dist/workers/small100-worker.js,
// copied next to the main bundle (<app>/bun/small100-worker.js). That bundle loads
// onnxruntime's native binding from <app>/native/onnxruntime/ (or GLIMPSE_ORT_BINDING).
//
// Lookup order:
//   1. GLIMPSE_SMALL100_WORKER (absolute path; tests, debugging)
//   2. <dir>/small100-worker.js: the bundled entry next to the main bundle
//   3. none: the provider's own default (source tree / `bun test`)
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Small100WorkerPort, Small100WorkerSpawner } from "@glimpse/providers/translation/small100";
import { disableOrtTelemetry } from "../ocr/ort-telemetry.ts";

export const SMALL100_WORKER_FILE = "small100-worker.js";

/** The Worker entry to use, or null for the provider's default. Pure apart from `exists`. */
export function resolveSmall100Worker(
	mainDir: string,
	env: Record<string, string | undefined> = process.env,
	exists: (path: string) => boolean = existsSync,
): string | null {
	const override = env["GLIMPSE_SMALL100_WORKER"];
	if (override) return resolve(override);
	const bundled = resolve(mainDir, SMALL100_WORKER_FILE);
	return exists(bundled) ? bundled : null;
}

/**
 * A spawner for `ctx.small100.spawn`, or undefined to keep the provider's default. The Worker
 * loads onnxruntime in this process, so its telemetry is switched off first (GLIM-112).
 */
export function small100Spawner(
	mainDir: string,
	env: Record<string, string | undefined> = process.env,
	exists: (path: string) => boolean = existsSync,
	disableTelemetry: () => boolean = disableOrtTelemetry,
): { readonly spawn: Small100WorkerSpawner | undefined; readonly path: string | null } {
	disableTelemetry();
	const path = resolveSmall100Worker(mainDir, env, exists);
	if (!path) return { spawn: undefined, path: null };
	return { spawn: () => new Worker(path) as unknown as Small100WorkerPort, path };
}
