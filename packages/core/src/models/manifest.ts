// The model manifest: every downloadable artifact Glimpse knows by URL and hash (OCR models,
// the Bergamot runtime), which of them ship in the installer and which download on demand.
// The checked-in copy is app/models/manifest.json (GLIM-37). Bergamot language packs are not
// listed here: their catalogue comes from Mozilla Remote Settings at run time (GLIM-38).
//
// Pure: parse and validate plain JSON, no file or network access.

import type { OcrRecognizer } from "../language/ocr.ts";
import { OCR_RECOGNIZERS } from "../language/ocr.ts";

export const MODEL_MANIFEST_SCHEMA = 1;

export type ModelKind = "ocr-detector" | "ocr-recognizer" | "translation-runtime";

const MODEL_KINDS: readonly ModelKind[] = ["ocr-detector", "ocr-recognizer", "translation-runtime"];

/** One file of a model. */
export interface ModelFile {
	/** File name inside the model's folder (no directories). */
	readonly name: string;
	/** Download URLs, tried in order (primary first, then mirrors). */
	readonly urls: readonly string[];
	/** SHA-256 (lowercase hex) of the bytes as downloaded. */
	readonly sha256: string;
	/** Size in bytes as downloaded. */
	readonly size: number;
	/** Set when the download is compressed; the installed file is the decompressed one. */
	readonly compression?: "zstd";
	/** SHA-256 and size of the decompressed file. Required when `compression` is set. */
	readonly decompressedSha256?: string;
	readonly decompressedSize?: number;
}

export interface ModelEntry {
	/** Stable id, also the install folder name: `ocr-det`, `ocr-rec-latin`, `bergamot-runtime`. */
	readonly id: string;
	readonly kind: ModelKind;
	/** For `ocr-recognizer`: the script family it reads. */
	readonly recognizer?: OcrRecognizer;
	/** Ships inside the installer (true) or downloads on demand (false). */
	readonly bundled: boolean;
	/** SPDX licence id of the files. */
	readonly licence: string;
	/** Who made the files and where they came from (shown in About / notices). */
	readonly attribution: string;
	/** Upstream revision the hashes were pinned at (`RapidOCR v3.10.0`). */
	readonly revision: string;
	readonly files: readonly ModelFile[];
}

export interface ModelManifest {
	readonly schema: typeof MODEL_MANIFEST_SCHEMA;
	readonly models: readonly ModelEntry[];
}

export class ManifestError extends Error {
	override readonly name = "ManifestError";
}

const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate untrusted JSON as a manifest. Throws `ManifestError` naming the bad field. */
export function parseModelManifest(json: unknown): ModelManifest {
	const root = object(json, "manifest");
	if (root["schema"] !== MODEL_MANIFEST_SCHEMA) {
		throw new ManifestError(
			`manifest.schema: expected ${MODEL_MANIFEST_SCHEMA}, got ${JSON.stringify(root["schema"])}`,
		);
	}
	const models = array(root["models"], "manifest.models").map((m, i) => parseEntry(m, `models[${i}]`));
	const ids = new Set<string>();
	for (const m of models) {
		if (ids.has(m.id)) throw new ManifestError(`duplicate model id ${m.id}`);
		ids.add(m.id);
	}
	return { schema: MODEL_MANIFEST_SCHEMA, models };
}

function parseEntry(json: unknown, path: string): ModelEntry {
	const o = object(json, path);
	const id = string(o["id"], `${path}.id`);
	if (!ID.test(id)) throw new ManifestError(`${path}.id: not a valid id: ${id}`);
	const kind = string(o["kind"], `${path}.kind`) as ModelKind;
	if (!MODEL_KINDS.includes(kind)) throw new ManifestError(`${path}.kind: unknown kind ${kind}`);
	let recognizer: OcrRecognizer | undefined;
	if (kind === "ocr-recognizer") {
		recognizer = string(o["recognizer"], `${path}.recognizer`) as OcrRecognizer;
		if (!OCR_RECOGNIZERS.includes(recognizer)) {
			throw new ManifestError(`${path}.recognizer: unknown recogniser ${recognizer}`);
		}
	}
	const bundled = o["bundled"];
	if (typeof bundled !== "boolean") throw new ManifestError(`${path}.bundled: expected a boolean`);
	const files = array(o["files"], `${path}.files`).map((f, i) => parseFile(f, `${path}.files[${i}]`));
	if (files.length === 0) throw new ManifestError(`${path}.files: empty`);
	const entry: ModelEntry = {
		id,
		kind,
		bundled,
		licence: string(o["licence"], `${path}.licence`),
		attribution: string(o["attribution"], `${path}.attribution`),
		revision: string(o["revision"], `${path}.revision`),
		files,
	};
	return recognizer ? { ...entry, recognizer } : entry;
}

function parseFile(json: unknown, path: string): ModelFile {
	const o = object(json, path);
	const name = string(o["name"], `${path}.name`);
	if (!FILE_NAME.test(name) || name.includes("..")) throw new ManifestError(`${path}.name: unsafe file name ${name}`);
	const urls = array(o["urls"], `${path}.urls`).map((u, i) => url(u, `${path}.urls[${i}]`));
	if (urls.length === 0) throw new ManifestError(`${path}.urls: empty`);
	const file: ModelFile = {
		name,
		urls,
		sha256: sha(o["sha256"], `${path}.sha256`),
		size: size(o["size"], `${path}.size`),
	};
	const compression = o["compression"];
	if (compression === undefined) return file;
	if (compression !== "zstd")
		throw new ManifestError(`${path}.compression: unsupported ${JSON.stringify(compression)}`);
	return {
		...file,
		compression,
		decompressedSha256: sha(o["decompressedSha256"], `${path}.decompressedSha256`),
		decompressedSize: size(o["decompressedSize"], `${path}.decompressedSize`),
	};
}

function object(v: unknown, path: string): Record<string, unknown> {
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ManifestError(`${path}: expected an object`);
	return v as Record<string, unknown>;
}
function array(v: unknown, path: string): unknown[] {
	if (!Array.isArray(v)) throw new ManifestError(`${path}: expected an array`);
	return v;
}
function string(v: unknown, path: string): string {
	if (typeof v !== "string" || v === "") throw new ManifestError(`${path}: expected a non-empty string`);
	return v;
}
function sha(v: unknown, path: string): string {
	const s = string(v, path);
	if (!SHA256.test(s)) throw new ManifestError(`${path}: expected lowercase hex SHA-256`);
	return s;
}
function size(v: unknown, path: string): number {
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0)
		throw new ManifestError(`${path}: expected a byte count`);
	return v;
}
function url(v: unknown, path: string): string {
	const s = string(v, path);
	if (!/^https:\/\//.test(s)) throw new ManifestError(`${path}: only https URLs are allowed`);
	return s;
}

/** Size on disk once installed (decompressed sizes for compressed files). */
export function installedSize(model: ModelEntry): number {
	return model.files.reduce((n, f) => n + (f.decompressedSize ?? f.size), 0);
}

/** Bytes to download. */
export function downloadSize(model: ModelEntry): number {
	return model.files.reduce((n, f) => n + f.size, 0);
}

export function bundledModels(manifest: ModelManifest): readonly ModelEntry[] {
	return manifest.models.filter((m) => m.bundled);
}

/** The manifest entry for a recogniser family, if the manifest has one. */
export function recognizerModel(manifest: ModelManifest, recognizer: OcrRecognizer): ModelEntry | undefined {
	return manifest.models.find((m) => m.kind === "ocr-recognizer" && m.recognizer === recognizer);
}
