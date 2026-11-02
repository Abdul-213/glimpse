// GLIM-95: the OCR models' mirror on a Glimpse GitHub release. ModelScope (China-hosted, the
// primary URL in app/models/manifest.json) can be slow or blocked, so every PP-OCRv5 file is
// also a release asset of `models-ocr-<RapidOCR revision>` on github.com/Abdul-213/glimpse,
// listed second in the file's `urls`. Same bytes, same SHA-256: the downloader tries the URLs
// in order and verifies whatever it gets (src/bun/services/models/download.ts).
//
//   bun scripts/model-mirror.ts --check          every OCR file lists its mirror URL (CI-safe, offline)
//   bun scripts/model-mirror.ts --stage <dir>    fetch (verified) into the cache, then write the
//                                                release assets: the files, NOTICE.txt, the
//                                                Apache-2.0 licence and SHA256SUMS
//   bun scripts/model-mirror.ts --tag            print the release tag
//   bun scripts/model-mirror.ts --notes          print the release notes
//
// The release itself is made by .github/workflows/model-mirror.yml (manual runs only). Note:
// while the repository is private, release assets need a GitHub login, so the mirror only
// serves users once the repository (or a public mirror repository) is public.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelEntry, ModelFile, ModelManifest } from "@glimpse/core";
import { defaultCacheDir, ensureCached, loadManifest, modelsSrc } from "./model-cache.ts";

export const MIRROR_REPO = "Abdul-213/glimpse";

/** The OCR models (detector + recognisers): the ones that come from ModelScope. */
export const ocrModels = (manifest: ModelManifest): ModelEntry[] =>
	manifest.models.filter((m) => m.kind === "ocr-detector" || m.kind === "ocr-recognizer");

/** `models-ocr-v3.10.0` for revision "RapidOCR v3.10.0". All OCR models share one revision. */
export function mirrorTag(manifest: ModelManifest): string {
	const revisions = [...new Set(ocrModels(manifest).map((m) => m.revision))];
	if (revisions.length !== 1) throw new Error(`OCR models have ${revisions.length} revisions: ${revisions.join(", ")}`);
	const version = /v?(\d+\.\d+\.\d+)/.exec(revisions[0] ?? "")?.[1];
	if (!version) throw new Error(`no version in OCR revision ${JSON.stringify(revisions[0])}`);
	return `models-ocr-v${version}`;
}

export const mirrorUrl = (tag: string, name: string, repo = MIRROR_REPO): string =>
	`https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;

/** Every OCR file once (release asset names must be unique). */
export function mirrorFiles(manifest: ModelManifest): ModelFile[] {
	const byName = new Map<string, ModelFile>();
	for (const m of ocrModels(manifest)) {
		for (const f of m.files) {
			const seen = byName.get(f.name);
			if (seen && seen.sha256 !== f.sha256) throw new Error(`two different OCR files are named ${f.name}`);
			byName.set(f.name, f);
		}
	}
	return [...byName.values()];
}

/** Problems with the manifest's mirror URLs (empty = fine): each OCR file lists it first or second. */
export function checkMirrors(manifest: ModelManifest): string[] {
	const tag = mirrorTag(manifest);
	const problems: string[] = [];
	for (const m of ocrModels(manifest)) {
		for (const f of m.files) {
			const at = f.urls.indexOf(mirrorUrl(tag, f.name));
			if (at < 0) problems.push(`${m.id}/${f.name}: no mirror URL ${mirrorUrl(tag, f.name)}`);
			else if (at > 1) problems.push(`${m.id}/${f.name}: mirror URL is #${at + 1}; list it first or second`);
		}
	}
	return problems;
}

/** Fetch every OCR file (verified) and write the release assets into `outDir`. Returns the asset names. */
export async function stageMirror(
	manifest: ModelManifest,
	outDir: string,
	options: { cacheDir: string; log?: (line: string) => void; fetch?: Parameters<typeof ensureCached>[1]["fetch"] },
): Promise<string[]> {
	mkdirSync(outDir, { recursive: true });
	const names: string[] = [];
	const sums: string[] = [];
	for (const f of mirrorFiles(manifest)) {
		if (f.compression) throw new Error(`${f.name}: compressed files can't be mirrored as-is`);
		const cached = await ensureCached(f, {
			cacheDir: options.cacheDir,
			...(options.log ? { log: options.log } : {}),
			...(options.fetch ? { fetch: options.fetch } : {}),
		});
		copyFileSync(cached, join(outDir, f.name));
		names.push(f.name);
		sums.push(`${f.sha256}  ${f.name}`);
	}
	// Apache-2.0 §4: the licence and the notices go with the files.
	copyFileSync(join(modelsSrc, "NOTICE.txt"), join(outDir, "NOTICE.txt"));
	copyFileSync(join(modelsSrc, "licenses", "Apache-2.0.txt"), join(outDir, "LICENSE-Apache-2.0.txt"));
	writeFileSync(join(outDir, "SHA256SUMS"), `${sums.join("\n")}\n`);
	return [...names, "NOTICE.txt", "LICENSE-Apache-2.0.txt", "SHA256SUMS"];
}

/** Release notes for the mirror release. */
export function mirrorNotes(manifest: ModelManifest): string {
	const tag = mirrorTag(manifest);
	const revision = ocrModels(manifest)[0]?.revision ?? "";
	return [
		`Mirror of the PaddleOCR PP-OCRv5 mobile ONNX models Glimpse uses (${revision}), so they can be`,
		"downloaded when ModelScope is slow or blocked. Not an app release.",
		"",
		"The files are byte-for-byte the upstream ones (SHA256SUMS; app/models/manifest.json lists the same",
		"hashes). Models by the PaddlePaddle Authors, ONNX conversions by RapidAI, licensed under the Apache",
		"License, Version 2.0 (LICENSE-Apache-2.0.txt); see NOTICE.txt.",
		"",
		`Tag: ${tag}. Made by .github/workflows/model-mirror.yml (GLIM-95).`,
	].join("\n");
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const manifest = loadManifest();
	if (args.includes("--tag")) {
		console.log(mirrorTag(manifest));
	} else if (args.includes("--notes")) {
		console.log(mirrorNotes(manifest));
	} else if (args.includes("--check")) {
		const problems = checkMirrors(manifest);
		for (const p of problems) console.error(p);
		if (problems.length > 0) process.exit(1);
		console.log(`${mirrorFiles(manifest).length} OCR files list ${mirrorUrl(mirrorTag(manifest), "")}<name>`);
	} else if (args.includes("--stage")) {
		const out = args[args.indexOf("--stage") + 1];
		if (!out || out.startsWith("--")) throw new Error("--stage needs a directory");
		const names = await stageMirror(manifest, out, { cacheDir: defaultCacheDir(), log: (l) => console.log(l) });
		console.log(`staged ${names.length} assets for ${mirrorTag(manifest)} -> ${out}`);
	} else {
		console.error("usage: model-mirror.ts --check | --stage <dir> | --tag | --notes");
		process.exit(2);
	}
}
