// Where the Bergamot inference Worker entry lives, and how to spawn it (GLIM-101).
//
// From source, the provider spawns `new Worker(new URL("./worker.ts", import.meta.url))`
// inside packages/providers. In the Electrobun bundle that URL points next to
// <app>/bun/index.js, where no worker.ts exists, so the preBuild hook bundles the Worker as
// its own entry (scripts/build-workers.ts -> dist/workers/bergamot-worker.js) and
// electrobun.config.ts copies it to <app>/bun/bergamot-worker.js.
//
// Lookup order (like native/load.ts):
//   1. GLIMPSE_BERGAMOT_WORKER (absolute path; tests, debugging)
//   2. <dir>/bergamot-worker.js: the bundled entry next to the main bundle
//   3. none: the provider's own default (source tree / `bun test`)
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkerPort, WorkerSpawner } from "@glimpse/providers/translation/bergamot";

export const BERGAMOT_WORKER_FILE = "bergamot-worker.js";

/** The Worker entry to use, or null for the provider's default. Pure apart from `exists`. */
export function resolveBergamotWorker(
	mainDir: string,
	env: Record<string, string | undefined> = process.env,
	exists: (path: string) => boolean = existsSync,
): string | null {
	const override = env["GLIMPSE_BERGAMOT_WORKER"];
	if (override) return resolve(override);
	const bundled = resolve(mainDir, BERGAMOT_WORKER_FILE);
	return exists(bundled) ? bundled : null;
}

/** A spawner for `ctx.bergamot.spawn`, or undefined to keep the provider's default. */
export function bergamotSpawner(
	mainDir: string,
	env: Record<string, string | undefined> = process.env,
	exists: (path: string) => boolean = existsSync,
): { readonly spawn: WorkerSpawner | undefined; readonly path: string | null } {
	const path = resolveBergamotWorker(mainDir, env, exists);
	if (!path) return { spawn: undefined, path: null };
	return { spawn: () => new Worker(path) as unknown as WorkerPort, path };
}
