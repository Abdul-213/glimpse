// Dev/CI model cache: downloads the files in app/models/manifest.json into a content-addressed
// cache (default ~/.cache/glimpse/models), verifies SHA-256, unpacks zstd, and stages the
// bundled ones into dist/models for electrobun.config.ts to copy into the app. Used by
// scripts/fetch-models.ts (CLI) and scripts/prebuild.ts. The app's own on-demand downloads
// go through the model download manager (src/bun/services/models/), which shares the downloader.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { bundledModels, type ModelEntry, type ModelFile, type ModelManifest, parseModelManifest } from "@glimpse/core";
import { downloadFile, type FetchLike } from "../src/bun/services/models/download.ts";

export const appRoot = resolve(import.meta.dir, "..");
export const modelsSrc = join(appRoot, "models");
export const manifestPath = join(modelsSrc, "manifest.json");
export const modelsOut = join(appRoot, "dist", "models");

export function loadManifest(path = manifestPath): ModelManifest {
	return parseModelManifest(JSON.parse(readFileSync(path, "utf8")));
}

/** `$GLIMPSE_MODEL_CACHE`, else `$XDG_CACHE_HOME/glimpse/models`, else `~/.cache/glimpse/models`. */
export function defaultCacheDir(env: Record<string, string | undefined> = process.env): string {
	const explicit = env["GLIMPSE_MODEL_CACHE"];
	if (explicit) return resolve(explicit);
	return join(env["XDG_CACHE_HOME"] || join(homedir(), ".cache"), "glimpse", "models");
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** The hash of the file as installed (decompressed when the download is compressed). */
export function installedHash(file: ModelFile): string {
	return file.decompressedSha256 ?? file.sha256;
}

/** Cache path of a file: `<cache>/sha256/<installed hash>`. Shared across names and URLs. */
export function cachePath(cacheDir: string, file: ModelFile): string {
	return join(cacheDir, "sha256", installedHash(file));
}

export interface FetchOptions {
	readonly cacheDir: string;
	readonly fetch?: FetchLike;
	readonly log?: (line: string) => void;
}

/** Make sure one file is in the cache and verified. Returns its cache path. */
export async function ensureCached(file: ModelFile, options: FetchOptions): Promise<string> {
	const dest = cachePath(options.cacheDir, file);
	if (existsSync(dest) && sha256Hex(readFileSync(dest)) === installedHash(file)) return dest;
	mkdirSync(join(options.cacheDir, "sha256"), { recursive: true });
	const started = performance.now();
	try {
		// Same downloader as the app (resume, verify, zstd); see src/bun/services/models/download.ts.
		await downloadFile(file, dest, options.fetch ? { fetch: options.fetch } : {});
	} catch (err) {
		throw new Error(`could not fetch ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const secs = ((performance.now() - started) / 1000).toFixed(1);
	options.log?.(`  ${(file.size / 1e6).toFixed(1).padStart(6)} MB  ${secs}s  ${file.name}`);
	return dest;
}

export async function ensureModel(model: ModelEntry, options: FetchOptions): Promise<void> {
	for (const file of model.files) await ensureCached(file, options);
}

/** True when every file of `model` is already in the cache (by path only; cheap). */
export function isCached(model: ModelEntry, cacheDir: string): boolean {
	return model.files.every((f) => existsSync(cachePath(cacheDir, f)));
}

/**
 * Copy the bundled models from the cache into `outDir` as `<id>/<file name>`, plus a manifest
 * of just those models (the app reads it to know what shipped), NOTICE.txt and licenses/.
 * Fetches missing files first. Replaces `outDir`.
 */
export async function stageBundled(manifest: ModelManifest, outDir: string, options: FetchOptions): Promise<string[]> {
	const models = bundledModels(manifest);
	for (const m of models) await ensureModel(m, options);
	rmSync(outDir, { recursive: true, force: true });
	for (const m of models) {
		mkdirSync(join(outDir, m.id), { recursive: true });
		for (const f of m.files) copyFileSync(cachePath(options.cacheDir, f), join(outDir, m.id, f.name));
	}
	writeStagingExtras(outDir, { schema: manifest.schema, models });
	return models.map((m) => m.id);
}

/** Write manifest.json, NOTICE.txt and licenses/ into `outDir` (also used for an empty stage). */
export function writeStagingExtras(outDir: string, manifest: ModelManifest): void {
	mkdirSync(join(outDir, "licenses"), { recursive: true });
	writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	copyFileSync(join(modelsSrc, "NOTICE.txt"), join(outDir, "NOTICE.txt"));
	for (const licence of ["Apache-2.0.txt", "MPL-2.0.txt", "MIT-onnxruntime.txt"]) {
		copyFileSync(join(modelsSrc, "licenses", licence), join(outDir, "licenses", licence));
	}
}
