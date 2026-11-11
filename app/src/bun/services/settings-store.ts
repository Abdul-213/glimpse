// File-backed SettingsStore (core port, GLIM-53): `settings.json` in the user data dir.
//
// - Atomic replace: write a unique temp file next to the target, fsync it, rename over the
//   target, then fsync the directory (POSIX). A crash leaves the old or the new file, never a
//   torn one. On Windows, rename can fail briefly with EPERM/EBUSY while an antivirus or
//   indexer has the file open, so it is retried a few times.
// - Backups (`settings.json.<reason>-<stamp>.bak`) are copies; the newest few per reason are kept.
// - Policy (what is corrupt, when to back up or migrate) lives in @glimpse/core's
//   `loadSettings`; this file only does I/O, so it can be tested on Linux with a temp dir.
//
// No electrobun imports: the composition root passes `Utils.paths.userData`.

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { BackupReason, SettingsStore } from "@glimpse/core";

export const SETTINGS_FILE = "settings.json";

export interface FileSettingsStoreOptions {
	/** Clock for backup names (tests). */
	readonly now?: () => number;
	/** Backups kept per reason. Default 3. */
	readonly keepBackups?: number;
	/** `process.platform` (tests can pretend to be Windows for the retry path). */
	readonly platform?: NodeJS.Platform;
	/** Sleep between rename retries (tests pass a no-op). */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Rename implementation (tests inject transient failures). */
	readonly rename?: (from: string, to: string) => Promise<void>;
}

const RETRYABLE_RENAME = new Set(["EPERM", "EACCES", "EBUSY"]);

const errorCode = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;

export class FileSettingsStore implements SettingsStore {
	readonly path: string;
	readonly #now: () => number;
	readonly #keep: number;
	readonly #platform: NodeJS.Platform;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #rename: (from: string, to: string) => Promise<void>;

	constructor(path: string, options: FileSettingsStoreOptions = {}) {
		this.path = path;
		this.#now = options.now ?? Date.now;
		this.#keep = options.keepBackups ?? 3;
		this.#platform = options.platform ?? process.platform;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.#rename = options.rename ?? rename;
	}

	/** `<userData>/settings.json`. */
	static inDirectory(userDataDir: string, options?: FileSettingsStoreOptions): FileSettingsStore {
		return new FileSettingsStore(join(userDataDir, SETTINGS_FILE), options);
	}

	async read(): Promise<string | null> {
		try {
			return await readFile(this.path, "utf8");
		} catch (error) {
			if (errorCode(error) === "ENOENT") return null;
			throw error;
		}
	}

	async write(contents: string): Promise<void> {
		const dir = dirname(this.path);
		await mkdir(dir, { recursive: true });
		const tmp = join(dir, `.${basename(this.path)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
		try {
			const handle = await open(tmp, "w", 0o600);
			try {
				await handle.writeFile(contents, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.#renameWithRetry(tmp, this.path);
		} catch (error) {
			await rm(tmp, { force: true }).catch(() => {});
			throw error;
		}
		await this.#syncDirectory(dir);
	}

	async backup(reason: BackupReason): Promise<string | null> {
		const stamp = new Date(this.#now()).toISOString().replace(/[:.]/g, "-");
		const dest = `${this.path}.${reason}-${stamp}.bak`;
		try {
			await copyFile(this.path, dest);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return null;
			throw error;
		}
		await this.#prune(reason);
		return dest;
	}

	async #renameWithRetry(from: string, to: string): Promise<void> {
		const attempts = this.#platform === "win32" ? 6 : 1;
		for (let i = 1; ; i++) {
			try {
				await this.#rename(from, to);
				return;
			} catch (error) {
				if (i >= attempts || !RETRYABLE_RENAME.has(errorCode(error) ?? "")) throw error;
				await this.#sleep(15 * i);
			}
		}
	}

	async #syncDirectory(dir: string): Promise<void> {
		// Makes the rename itself durable on POSIX. Windows can't open directories this way.
		if (this.#platform === "win32") return;
		try {
			const handle = await open(dir, "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch {
			// Best effort: some filesystems refuse fsync on directories.
		}
	}

	async #prune(reason: BackupReason): Promise<void> {
		const dir = dirname(this.path);
		const prefix = `${basename(this.path)}.${reason}-`;
		const names = (await readdir(dir)).filter((n) => n.startsWith(prefix) && n.endsWith(".bak")).sort();
		for (const name of names.slice(0, Math.max(0, names.length - this.#keep))) {
			await rm(join(dir, name), { force: true });
		}
	}
}
