// Download one model file with progress, resume, SHA-256 verification and zstd unpacking.
// Writes `<dest>.part` while downloading (kept on failure or cancel so the next attempt resumes
// with an HTTP Range request) and renames into `dest` only after the hash matches.
// No Electrobun imports: tested on Linux against a local HTTP server.
import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { InstallError, InstallErrorKind, ModelFile } from "@glimpse/core";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class DownloadError extends Error implements InstallError {
	override readonly name = "DownloadError";
	constructor(
		readonly kind: InstallErrorKind,
		message: string,
	) {
		super(message);
	}
}

export interface DownloadOptions {
	readonly fetch?: FetchLike;
	readonly signal?: AbortSignal;
	/** Bytes of this file received so far (including resumed bytes), and its total size. */
	readonly onProgress?: (receivedBytes: number, totalBytes: number) => void;
}

/** SHA-256 of a file on disk, streamed. Null if the file doesn't exist. */
export async function hashFile(path: string): Promise<string | null> {
	const hash = createHash("sha256");
	return (await hashInto(path, hash)) ? hash.digest("hex") : null;
}

/** Feed a file's bytes into `hash` without finishing it. False if the file doesn't exist. */
async function hashInto(path: string, hash: Hash): Promise<boolean> {
	try {
		for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
		return true;
	} catch (err) {
		if (isErrno(err, "ENOENT")) return false;
		throw err;
	}
}

/** True when `dest` already holds the installed form of `file`. */
export async function isInstalledFile(file: ModelFile, dest: string): Promise<boolean> {
	return (await hashFile(dest)) === (file.decompressedSha256 ?? file.sha256);
}

/**
 * Download `file` to `dest`, trying each URL in order. Resolves when `dest` holds the verified
 * (decompressed) file. Rejects with a `DownloadError`: `cancelled` when the signal aborts,
 * `network`/`http` when no URL worked, `checksum` when every URL served bad bytes,
 * `disk-full`/`io` for filesystem errors.
 */
export async function downloadFile(file: ModelFile, dest: string, options: DownloadOptions = {}): Promise<void> {
	if (await isInstalledFile(file, dest)) {
		options.onProgress?.(file.size, file.size);
		return;
	}
	const part = `${dest}.part`;
	let lastError: DownloadError | null = null;
	for (const url of file.urls) {
		try {
			await fetchToPart(url, file, part, options);
			await finish(file, part, dest);
			return;
		} catch (err) {
			const error = toDownloadError(err, options.signal);
			if (error.kind === "cancelled" || error.kind === "disk-full" || error.kind === "io") throw error;
			lastError = error;
		}
	}
	throw lastError ?? new DownloadError("http", `no URL for ${file.name}`);
}

async function fetchToPart(url: string, file: ModelFile, part: string, options: DownloadOptions): Promise<void> {
	const doFetch = options.fetch ?? fetch;
	let offset = await sizeOf(part);
	if (offset > file.size) {
		await rm(part, { force: true });
		offset = 0;
	}

	let hash = createHash("sha256");
	if (offset === file.size) {
		// A complete .part from an earlier run: verify it without downloading anything.
		await hashInto(part, hash);
		return verifyPart(file, part, hash.digest("hex"), url);
	}
	if (offset > 0) await hashInto(part, hash);

	options.signal?.throwIfAborted();
	const headers: Record<string, string> = offset > 0 ? { range: `bytes=${offset}-` } : {};
	const init: RequestInit = { headers, redirect: "follow" };
	if (options.signal) init.signal = options.signal;
	const res = await doFetch(url, init);

	if (res.status === 206) {
		const start = /^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "")?.[1];
		if (Number(start) !== offset) {
			await res.body?.cancel();
			throw new DownloadError("http", `bad Content-Range from ${url}`);
		}
	} else if (res.ok) {
		// No range support (or no .part): start from byte 0.
		if (offset > 0) hash = createHash("sha256");
		offset = 0;
	} else {
		await res.body?.cancel();
		throw new DownloadError("http", `HTTP ${res.status} from ${url}`);
	}
	await writeBody(res, part, offset > 0, offset, hash, file, options);
	await verifyPart(file, part, hash.digest("hex"), url);
}

async function writeBody(
	res: Response,
	part: string,
	append: boolean,
	offset: number,
	hash: Hash,
	file: ModelFile,
	options: DownloadOptions,
): Promise<void> {
	if (!res.body) throw new DownloadError("http", "empty response body");
	const reader = res.body.getReader();
	const handle = await open(part, append ? "a" : "w");
	let received = offset;
	try {
		options.onProgress?.(received, file.size);
		for (;;) {
			const { done, value: chunk } = await reader.read();
			if (done) break;
			if (received + chunk.byteLength > file.size) {
				throw new DownloadError("checksum", `${file.name}: server sent more than ${file.size} bytes`);
			}
			hash.update(chunk);
			await handle.write(chunk);
			received += chunk.byteLength;
			options.onProgress?.(received, file.size);
		}
	} finally {
		reader.releaseLock();
		await handle.close();
	}
	if (received < file.size) {
		// Keep the .part: the next attempt resumes from here.
		throw new DownloadError("network", `${file.name}: connection closed after ${received} of ${file.size} bytes`);
	}
}

async function verifyPart(file: ModelFile, part: string, got: string, url: string): Promise<void> {
	if (got === file.sha256) return;
	await rm(part, { force: true }); // bad bytes: don't resume from them
	throw new DownloadError("checksum", `${file.name}: sha256 ${got} != ${file.sha256} (${url})`);
}

async function finish(file: ModelFile, part: string, dest: string): Promise<void> {
	if (file.compression !== "zstd") {
		await rename(part, dest);
		return;
	}
	const unpacked = Bun.zstdDecompressSync(await readFile(part));
	const got = createHash("sha256").update(unpacked).digest("hex");
	if (got !== file.decompressedSha256) {
		await rm(part, { force: true });
		throw new DownloadError("checksum", `${file.name}: decompressed sha256 ${got} != ${file.decompressedSha256}`);
	}
	const tmp = `${dest}.tmp`;
	await writeFile(tmp, unpacked);
	await rename(tmp, dest);
	await rm(part, { force: true });
}

async function sizeOf(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch (err) {
		if (isErrno(err, "ENOENT")) return 0;
		throw err;
	}
}

function isErrno(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

/** Map anything thrown while downloading to a `DownloadError`. */
export function toDownloadError(err: unknown, signal?: AbortSignal): DownloadError {
	if (err instanceof DownloadError) return err;
	if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
		return new DownloadError("cancelled", "download cancelled");
	}
	if (isErrno(err, "ENOSPC")) return new DownloadError("disk-full", "not enough disk space");
	if (typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string") {
		const code = (err as { code: string }).code;
		// Bun reports connection failures with codes like ConnectionRefused / ECONNRESET.
		if (/^E[A-Z]+$/.test(code) && !/^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_)/.test(code)) {
			return new DownloadError("io", err instanceof Error ? err.message : code);
		}
	}
	return new DownloadError("network", err instanceof Error ? err.message : String(err));
}
