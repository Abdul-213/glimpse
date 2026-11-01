// Where installable models come from: the checked-in manifest (OCR recognisers) and Mozilla
// Remote Settings (Bergamot packs). The Remote Settings catalogue is cached on disk so the app
// can still list packs, and report "offline" rather than "unknown", without a network.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type BergamotPack,
	bergamotRecordsUrl,
	type ModelEntry,
	packDescriptor,
	parseBergamotRecords,
	selectDesktopPacks,
} from "@glimpse/core";
import { DownloadError, type FetchLike, toDownloadError } from "./download.ts";
import type { Installable } from "./model-manager.ts";

export function manifestInstallable(model: ModelEntry): Installable {
	return { id: model.id, version: model.revision, files: model.files };
}

export function packInstallable(pack: BergamotPack): Installable {
	return { id: pack.id, version: pack.version, files: pack.files, extras: { "pack.json": packDescriptor(pack) } };
}

export interface BergamotCatalogue {
	readonly packs: readonly BergamotPack[];
	/** `network`: fresh from Remote Settings. `cache`: the last good copy (we're probably offline). */
	readonly source: "network" | "cache";
	readonly fetchedAt: number;
	/** Records skipped because they didn't match the expected schema. */
	readonly rejected: number;
}

export interface CatalogueOptions {
	/** JSON file holding the last good Remote Settings response. */
	readonly cacheFile: string;
	readonly fetch?: FetchLike;
	readonly url?: string;
	readonly attachmentsBase?: string;
	readonly now?: () => number;
}

interface CachedResponse {
	readonly fetchedAt: number;
	readonly body: unknown;
}

/**
 * Fetch the Bergamot pack catalogue, falling back to the cached copy when the network fails.
 * Throws a `DownloadError` (`network` or `http`) only when there is no cached copy either.
 */
export async function loadBergamotCatalogue(options: CatalogueOptions): Promise<BergamotCatalogue> {
	const doFetch = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	try {
		const res = await doFetch(options.url ?? bergamotRecordsUrl(), { headers: { accept: "application/json" } });
		if (!res.ok) throw new DownloadError("http", `Remote Settings: HTTP ${res.status}`);
		const body: unknown = await res.json();
		const parsed = parseBergamotRecords(body);
		if (parsed.records.length === 0) throw new DownloadError("http", "Remote Settings: no usable records");
		const fetchedAt = now();
		await saveCache(options.cacheFile, { fetchedAt, body });
		return {
			packs: selectDesktopPacks(parsed.records, options.attachmentsBase),
			source: "network",
			fetchedAt,
			rejected: parsed.rejected,
		};
	} catch (err) {
		const error = toDownloadError(err);
		const cached = await readCache(options.cacheFile);
		if (!cached) throw error;
		const parsed = parseBergamotRecords(cached.body);
		return {
			packs: selectDesktopPacks(parsed.records, options.attachmentsBase),
			source: "cache",
			fetchedAt: cached.fetchedAt,
			rejected: parsed.rejected,
		};
	}
}

async function saveCache(file: string, data: CachedResponse): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	await writeFile(tmp, JSON.stringify(data));
	await rename(tmp, file);
}

async function readCache(file: string): Promise<CachedResponse | null> {
	try {
		const data = JSON.parse(await readFile(file, "utf8")) as Partial<CachedResponse>;
		return typeof data.fetchedAt === "number" && data.body !== undefined
			? { fetchedAt: data.fetchedAt, body: data.body }
			: null;
	} catch {
		return null;
	}
}
