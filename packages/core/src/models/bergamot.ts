// Firefox Translations (Bergamot) language packs from Mozilla Remote Settings, collection
// `translations-models-v2` (spikes/inference/FINDINGS.md, GLIM-38). Pure: the app fetches the
// records JSON and hands it here; this module validates it defensively (Mozilla has changed the
// schema before) and applies Firefox desktop's pack-selection rules.

import type { LanguageCode } from "../language/code.ts";
import { fromBergamot } from "../language/lookup.ts";
import type { ModelFile } from "./manifest.ts";

export const REMOTE_SETTINGS_BASE = "https://firefox.settings.services.mozilla.com/v1/buckets/main/collections";
export const BERGAMOT_MODELS_COLLECTION = "translations-models-v2";
export const REMOTE_SETTINGS_ATTACHMENTS = "https://firefox-settings-attachments.cdn.mozilla.net/";

export const bergamotRecordsUrl = (base = REMOTE_SETTINGS_BASE): string =>
	`${base}/${BERGAMOT_MODELS_COLLECTION}/records`;

export type BergamotFileType = "model" | "lex" | "vocab" | "srcvocab" | "trgvocab";
const FILE_TYPES: readonly BergamotFileType[] = ["model", "lex", "vocab", "srcvocab", "trgvocab"];

/** One Remote Settings record (one file), the fields we use. */
export interface BergamotRecord {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly fileType: BergamotFileType;
	readonly architecture: string;
	readonly sourceLanguage: string;
	readonly targetLanguage: string;
	readonly filterExpression: string;
	readonly decompressedHash: string;
	readonly decompressedSize: number;
	readonly attachment: { readonly hash: string; readonly size: number; readonly location: string };
}

export interface BergamotPackFile extends ModelFile {
	readonly fileType: BergamotFileType;
}

/** One translation direction at one version: the set of files Bergamot loads together. */
export interface BergamotPack {
	/** Install id, also the folder name: `bergamot-ja-en`. */
	readonly id: string;
	readonly source: LanguageCode;
	readonly target: LanguageCode;
	/** The Remote Settings language codes, as Bergamot's files name them. */
	readonly sourceCode: string;
	readonly targetCode: string;
	readonly version: string;
	readonly architecture: string;
	readonly files: readonly BergamotPackFile[];
}

export interface ParsedRecords {
	readonly records: readonly BergamotRecord[];
	/** Records that didn't match the schema (skipped, for diagnostics). */
	readonly rejected: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Parse a Remote Settings `/records` response (`{ data: [...] }`). Bad records are skipped. */
export function parseBergamotRecords(json: unknown): ParsedRecords {
	const data = typeof json === "object" && json !== null ? (json as { data?: unknown }).data : undefined;
	if (!Array.isArray(data)) throw new Error("Remote Settings response has no data array");
	const records: BergamotRecord[] = [];
	let rejected = 0;
	for (const raw of data) {
		const record = parseRecord(raw);
		if (record) records.push(record);
		else rejected++;
	}
	return { records, rejected };
}

function parseRecord(raw: unknown): BergamotRecord | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const att = r["attachment"];
	if (typeof att !== "object" || att === null) return null;
	const a = att as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" ? v : null);
	const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);
	const fileType = str(r["fileType"]) as BergamotFileType | null;
	const fields = {
		id: str(r["id"]),
		name: str(r["name"]),
		version: str(r["version"]),
		architecture: str(r["architecture"]) ?? "",
		sourceLanguage: str(r["sourceLanguage"]),
		targetLanguage: str(r["targetLanguage"]),
		filterExpression: str(r["filter_expression"]) ?? "",
		decompressedHash: str(r["decompressedHash"]),
		decompressedSize: int(r["decompressedSize"]),
		hash: str(a["hash"]),
		size: int(a["size"]),
		location: str(a["location"]),
	};
	if (!fileType || !FILE_TYPES.includes(fileType)) return null;
	const {
		id,
		name,
		version,
		sourceLanguage,
		targetLanguage,
		decompressedHash,
		decompressedSize,
		hash,
		size,
		location,
	} = fields;
	if (!id || !name || !version || !sourceLanguage || !targetLanguage || !location) return null;
	if (!decompressedHash || !SHA256.test(decompressedHash) || !hash || !SHA256.test(hash)) return null;
	if (!decompressedSize || !size) return null;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || location.includes("..")) return null;
	return {
		id,
		name,
		version,
		fileType,
		architecture: fields.architecture,
		sourceLanguage,
		targetLanguage,
		filterExpression: fields.filterExpression,
		decompressedHash,
		decompressedSize,
		attachment: { hash, size, location },
	};
}

/** Firefox desktop release targeting: no filter, or explicitly "not Android". */
export function isDesktopRelease(filterExpression: string): boolean {
	const f = filterExpression.trim();
	return f === "" || f === "env.appinfo.OS != 'Android'";
}

/** Pre-release versions look like `3.0a1`. */
export function isPrerelease(version: string): boolean {
	return /[a-z]\d*$/i.test(version);
}

/** Compare dotted numeric versions (`3.10` > `3.9`). Non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
	const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** Bigger models first when Mozilla publishes several for desktop at one version. */
const ARCHITECTURE_PREFERENCE = ["base", "base-memory", "tiny"];

function isComplete(files: readonly BergamotRecord[]): boolean {
	const types = new Set(files.map((f) => f.fileType));
	const vocab = types.has("vocab") || (types.has("srcvocab") && types.has("trgvocab"));
	const unique = new Set(files.map((f) => f.fileType)).size === files.length;
	return types.has("model") && types.has("lex") && vocab && unique;
}

export const bergamotPackId = (sourceCode: string, targetCode: string): string =>
	`bergamot-${sourceCode}-${targetCode}`.toLowerCase();

/**
 * Choose the pack Firefox desktop would use for every direction: desktop-release records
 * only, no pre-releases, highest version with a complete file set (model + lex + vocab, or
 * srcvocab + trgvocab), preferring `base` over `base-memory` over `tiny` at that version.
 * Directions whose language codes we can't map are skipped.
 */
export function selectDesktopPacks(
	records: readonly BergamotRecord[],
	attachmentsBase = REMOTE_SETTINGS_ATTACHMENTS,
): BergamotPack[] {
	const groups = new Map<string, BergamotRecord[]>();
	for (const r of records) {
		if (!isDesktopRelease(r.filterExpression) || isPrerelease(r.version)) continue;
		const key = `${r.sourceLanguage}\u0000${r.targetLanguage}`;
		const list = groups.get(key);
		if (list) list.push(r);
		else groups.set(key, [r]);
	}

	const packs: BergamotPack[] = [];
	for (const group of groups.values()) {
		const first = group[0];
		if (!first) continue;
		const source = fromBergamot(first.sourceLanguage);
		const target = fromBergamot(first.targetLanguage);
		if (!source || !target) continue;
		const candidates = new Map<string, BergamotRecord[]>();
		for (const r of group) {
			const key = `${r.version}\u0000${r.architecture}`;
			const list = candidates.get(key);
			if (list) list.push(r);
			else candidates.set(key, [r]);
		}
		const best = [...candidates.values()].filter(isComplete).sort((a, b) => {
			const [ra, rb] = [a[0], b[0]];
			if (!ra || !rb) return 0;
			return compareVersions(rb.version, ra.version) || archRank(ra.architecture) - archRank(rb.architecture);
		})[0];
		const head = best?.[0];
		if (!best || !head) continue;
		packs.push({
			id: bergamotPackId(head.sourceLanguage, head.targetLanguage),
			source,
			target,
			sourceCode: head.sourceLanguage,
			targetCode: head.targetLanguage,
			version: head.version,
			architecture: head.architecture,
			files: best
				.map((r) => toPackFile(r, attachmentsBase))
				.sort((a, b) => FILE_TYPES.indexOf(a.fileType) - FILE_TYPES.indexOf(b.fileType)),
		});
	}
	return packs.sort((a, b) => a.id.localeCompare(b.id));
}

function archRank(architecture: string): number {
	const i = ARCHITECTURE_PREFERENCE.indexOf(architecture);
	return i === -1 ? ARCHITECTURE_PREFERENCE.length : i;
}

function toPackFile(r: BergamotRecord, base: string): BergamotPackFile {
	return {
		fileType: r.fileType,
		name: r.name,
		urls: [new URL(r.attachment.location, base).toString()],
		sha256: r.attachment.hash,
		size: r.attachment.size,
		compression: "zstd",
		decompressedSha256: r.decompressedHash,
		decompressedSize: r.decompressedSize,
	};
}

/** Bytes to download for a pack (the `.zst` sizes). Show this in the UI. */
export function packDownloadSize(pack: BergamotPack): number {
	return pack.files.reduce((n, f) => n + f.size, 0);
}

/** Bytes on disk once installed. */
export function packInstalledSize(pack: BergamotPack): number {
	return pack.files.reduce((n, f) => n + (f.decompressedSize ?? f.size), 0);
}

/**
 * Newer pack for an installed direction, or null. A newer version is an optional update;
 * the installer keeps the old pack until the new one verifies.
 */
export function packUpdate(
	installed: { readonly id: string; readonly version: string },
	catalogue: readonly BergamotPack[],
): BergamotPack | null {
	const latest = catalogue.find((p) => p.id === installed.id);
	return latest && compareVersions(latest.version, installed.version) > 0 ? latest : null;
}

/** `pack.json` written next to an installed pack's files (same shape as the GLIM-17 spike's). */
export function packDescriptor(pack: BergamotPack): {
	src: string;
	tgt: string;
	version: string;
	architecture: string;
	files: Partial<Record<BergamotFileType, string>>;
} {
	const files: Partial<Record<BergamotFileType, string>> = {};
	for (const f of pack.files) files[f.fileType] = f.name;
	return { src: pack.sourceCode, tgt: pack.targetCode, version: pack.version, architecture: pack.architecture, files };
}
