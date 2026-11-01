// The model download manager (GLIM-38): installs OCR recognisers and Bergamot language packs
// into the user's models folder, with progress, resume, SHA-256 verification, zstd unpacking,
// a disk-space check, cancellation and an atomic swap into place. Bundled models (GLIM-37)
// are reported as installed from the app's own models/ folder.
//
// Layout under `root`:
//   <id>/                 installed model: its files + install.json (+ pack.json for Bergamot)
//   .staging/<id>@<ver>/  in-progress download (.part files survive restarts, so they resume)
//   .trash/               old versions being replaced; emptied on scan
//
// State per model follows the pure reducer in @glimpse/core (installReducer).
import { cp, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type Availability,
	type InstallEvent,
	type InstallState,
	installReducer,
	isBusy,
	MISSING,
	type ModelFile,
	parseModelManifest,
	requiredFreeBytes,
	summarizeAvailability,
} from "@glimpse/core";
import { DownloadError, downloadFile, type FetchLike, toDownloadError } from "./download.ts";

/** Something the manager can install: a manifest model or a Bergamot pack. */
export interface Installable {
	/** Folder name and state key. Lowercase letters, digits, dots and dashes. */
	readonly id: string;
	readonly version: string;
	readonly files: readonly ModelFile[];
	/** Extra JSON files written into the install folder, e.g. `{ "pack.json": {...} }`. */
	readonly extras?: Readonly<Record<string, unknown>>;
}

interface InstallRecord {
	readonly id: string;
	readonly version: string;
	readonly files: readonly string[];
	readonly installedAt: number;
}

interface Installed {
	readonly version: string;
	readonly dir: string;
	readonly bundled: boolean;
}

export interface ModelManagerOptions {
	/** Where downloaded models live. Configurable (settings); see `relocate` to move them. */
	readonly root: string;
	/** The app's bundled models folder (contains manifest.json), if any. */
	readonly bundledDir?: string | null;
	readonly fetch?: FetchLike;
	/** Free bytes on the volume holding `dir`. Default: `statfs`. */
	readonly freeBytes?: (dir: string) => Promise<number>;
	readonly now?: () => number;
	/** Minimum time between progress events per model. Default 100 ms. */
	readonly progressIntervalMs?: number;
}

export type StateListener = (id: string, state: InstallState) => void;

const ID = /^[a-z0-9][a-z0-9.-]*$/;
const RECORD = "install.json";

export class ModelManager {
	private rootDir: string;
	private readonly bundledDir: string | null;
	private readonly fetchImpl: FetchLike | undefined;
	private readonly freeBytes: (dir: string) => Promise<number>;
	private readonly now: () => number;
	private readonly progressIntervalMs: number;
	private readonly states = new Map<string, InstallState>();
	private readonly installed = new Map<string, Installed>();
	private readonly jobs = new Map<string, { controller: AbortController; done: Promise<InstallState> }>();
	private readonly listeners = new Set<StateListener>();
	private onlineFlag = true;

	constructor(options: ModelManagerOptions) {
		this.rootDir = options.root;
		this.bundledDir = options.bundledDir ?? null;
		this.fetchImpl = options.fetch;
		this.freeBytes = options.freeBytes ?? volumeFreeBytes;
		this.now = options.now ?? Date.now;
		this.progressIntervalMs = options.progressIntervalMs ?? 100;
	}

	get root(): string {
		return this.rootDir;
	}

	/** False after a download failed with a network error, until one succeeds again. */
	get online(): boolean {
		return this.onlineFlag;
	}

	/** Tell the manager about connectivity changes the app sees elsewhere. */
	setOnline(online: boolean): void {
		this.onlineFlag = online;
	}

	/** Read what is installed (bundled and downloaded) and clear leftovers. Call once at start. */
	async scan(): Promise<void> {
		await mkdir(this.rootDir, { recursive: true });
		await rm(join(this.rootDir, ".trash"), { recursive: true, force: true });
		this.installed.clear();
		if (this.bundledDir) {
			try {
				const manifest = parseModelManifest(JSON.parse(await readFile(join(this.bundledDir, "manifest.json"), "utf8")));
				for (const m of manifest.models) {
					const dir = join(this.bundledDir, m.id);
					if (await exists(dir)) this.installed.set(m.id, { version: m.revision, dir, bundled: true });
				}
			} catch {
				// No or unreadable bundled manifest (dev build without models): nothing bundled.
			}
		}
		for (const entry of await readdir(this.rootDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const record = await readRecord(join(this.rootDir, entry.name));
			if (record && record.id === entry.name) {
				this.installed.set(record.id, { version: record.version, dir: join(this.rootDir, record.id), bundled: false });
			}
		}
		for (const [id, info] of this.installed) {
			if (!this.jobs.has(id)) this.set(id, { status: "installed", version: info.version, bundled: info.bundled });
		}
	}

	state(id: string): InstallState {
		return this.states.get(id) ?? MISSING;
	}

	/** Folder with the model's files, or null when it isn't installed. Valid while a newer version downloads. */
	modelDir(id: string): string | null {
		return this.installed.get(id)?.dir ?? null;
	}

	/** Ids of every installed model (bundled and downloaded). */
	installedIds(): string[] {
		return [...this.installed.keys()];
	}

	installedVersion(id: string): string | null {
		return this.installed.get(id)?.version ?? null;
	}

	subscribe(listener: StateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Install (or update) a model. Concurrent calls for the same id share one download. */
	install(item: Installable): Promise<InstallState> {
		if (!ID.test(item.id)) return Promise.reject(new Error(`invalid model id ${JSON.stringify(item.id)}`));
		const running = this.jobs.get(item.id);
		if (running) return running.done;
		if (this.installed.get(item.id)?.version === item.version) return Promise.resolve(this.state(item.id));

		const controller = new AbortController();
		const done = this.run(item, controller.signal).finally(() => this.jobs.delete(item.id));
		this.jobs.set(item.id, { controller, done });
		return done;
	}

	/** Cancel a running install. Downloaded bytes are kept, so installing again resumes. */
	cancel(id: string): boolean {
		const job = this.jobs.get(id);
		job?.controller.abort();
		return job !== undefined;
	}

	/** Delete a downloaded model and any partial download. Bundled models can't be removed. */
	async remove(id: string): Promise<void> {
		if (!ID.test(id)) throw new Error(`invalid model id ${JSON.stringify(id)}`);
		if (this.jobs.has(id)) {
			this.cancel(id);
			await this.jobs.get(id)?.done;
		}
		const info = this.installed.get(id);
		if (info?.bundled) return;
		await rm(join(this.rootDir, id), { recursive: true, force: true });
		for (const name of await readdir(join(this.rootDir, ".staging")).catch(() => [] as string[])) {
			if (name.startsWith(`${id}@`)) await rm(join(this.rootDir, ".staging", name), { recursive: true, force: true });
		}
		this.installed.delete(id);
		this.dispatch(id, { type: "remove" });
	}

	/** Can a feature needing these models run now? (UI: ready / "Download (31 MB)" / offline.) */
	availability(needed: readonly { readonly id: string; readonly downloadBytes: number }[]): Availability {
		return summarizeAvailability(
			needed.map((n) => {
				const state = this.state(n.id);
				const info = this.installed.get(n.id);
				const effective: InstallState =
					info && !isBusy(state) ? { status: "installed", version: info.version, bundled: info.bundled } : state;
				return { id: n.id, state: effective, downloadBytes: n.downloadBytes };
			}),
			this.onlineFlag,
		);
	}

	/**
	 * Move downloaded models to a new folder (the user changed the storage location).
	 * Fails if a download is running. Same-volume moves are renames; others copy then delete.
	 */
	async relocate(newRoot: string): Promise<void> {
		if (this.jobs.size > 0) throw new Error("can't move models while a download is running");
		if (newRoot === this.rootDir) return;
		await mkdir(newRoot, { recursive: true });
		for (const [id, info] of this.installed) {
			if (info.bundled) continue;
			const to = join(newRoot, id);
			await rm(to, { recursive: true, force: true });
			await move(info.dir, to);
		}
		await rm(join(this.rootDir, ".staging"), { recursive: true, force: true });
		this.rootDir = newRoot;
		await this.scan();
	}

	private async run(item: Installable, signal: AbortSignal): Promise<InstallState> {
		const { id } = item;
		const previous = this.installed.get(id);
		this.dispatch(id, { type: "queue" });
		const staging = join(this.rootDir, ".staging", `${id}@${item.version.replace(/[^A-Za-z0-9.-]/g, "_")}`);
		try {
			await mkdir(staging, { recursive: true });
			const already = await partialBytes(staging, item.files);
			const need = requiredFreeBytes(item.files, already);
			const free = await this.freeBytes(this.rootDir);
			if (free < need) {
				throw new DownloadError(
					"disk-full",
					`needs ${mb(need)} free (including headroom), ${mb(free)} available in ${this.rootDir}`,
				);
			}

			const total = item.files.reduce((n, f) => n + f.size, 0);
			let completed = 0;
			let lastEmit = Number.NEGATIVE_INFINITY;
			for (const file of item.files) {
				await downloadFile(file, join(staging, file.name), {
					...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
					signal,
					onProgress: (received) => {
						const t = this.now();
						const all = completed + received;
						if (t - lastEmit < this.progressIntervalMs && all < total) return;
						lastEmit = t;
						this.dispatch(id, { type: "progress", receivedBytes: all, totalBytes: total });
					},
				});
				completed += file.size;
			}
			this.onlineFlag = true;

			this.dispatch(id, { type: "verify" });
			signal.throwIfAborted();
			const record: InstallRecord = {
				id,
				version: item.version,
				files: item.files.map((f) => f.name),
				installedAt: this.now(),
			};
			await writeFile(join(staging, RECORD), `${JSON.stringify(record, null, "\t")}\n`);
			for (const [name, json] of Object.entries(item.extras ?? {})) {
				await writeFile(join(staging, name), `${JSON.stringify(json, null, "\t")}\n`);
			}

			this.dispatch(id, { type: "install" });
			await this.swapIn(id, staging);
			this.installed.set(id, { version: item.version, dir: join(this.rootDir, id), bundled: false });
			this.dispatch(id, { type: "done", version: item.version });
		} catch (err) {
			const error = toDownloadError(err, signal);
			if (error.kind === "network") this.onlineFlag = false;
			if (error.kind === "cancelled") {
				// Back to what we had: the old version, or nothing.
				this.set(
					id,
					previous ? { status: "installed", version: previous.version, bundled: previous.bundled } : MISSING,
				);
			} else {
				this.dispatch(id, { type: "fail", error: { kind: error.kind, message: error.message } });
			}
		}
		return this.state(id);
	}

	/** Atomically replace `<root>/<id>` with the staged folder; the old one goes to .trash first. */
	private async swapIn(id: string, staging: string): Promise<void> {
		const final = join(this.rootDir, id);
		const trash = join(this.rootDir, ".trash", `${id}-${this.now()}`);
		const hadOld = await exists(final);
		if (hadOld) {
			await mkdir(dirname(trash), { recursive: true });
			await rename(final, trash);
		}
		try {
			await rename(staging, final);
		} catch (err) {
			if (hadOld) await rename(trash, final).catch(() => {});
			throw err;
		}
		if (hadOld) await rm(trash, { recursive: true, force: true });
	}

	private dispatch(id: string, event: InstallEvent): void {
		this.set(id, installReducer(this.state(id), event));
	}

	private set(id: string, next: InstallState): void {
		if (this.states.get(id) === next) return;
		this.states.set(id, next);
		for (const listener of this.listeners) listener(id, next);
	}
}

async function readRecord(dir: string): Promise<InstallRecord | null> {
	try {
		const json = JSON.parse(await readFile(join(dir, RECORD), "utf8")) as Partial<InstallRecord>;
		if (typeof json.id !== "string" || typeof json.version !== "string" || !Array.isArray(json.files)) return null;
		for (const f of json.files) if (typeof f !== "string" || !(await exists(join(dir, f)))) return null;
		return json as InstallRecord;
	} catch {
		return null;
	}
}

/** Bytes already on disk for this install (finished files and .part files), for the disk check. */
async function partialBytes(staging: string, files: readonly ModelFile[]): Promise<number> {
	let n = 0;
	for (const f of files) {
		const done = await size(join(staging, f.name));
		n += done > 0 ? f.size : await size(join(staging, `${f.name}.part`));
	}
	return n;
}

async function size(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

async function exists(path: string): Promise<boolean> {
	return (await stat(path).catch(() => null)) !== null;
}

async function move(from: string, to: string): Promise<void> {
	try {
		await rename(from, to);
	} catch (err) {
		if ((err as { code?: string }).code !== "EXDEV") throw err;
		await cp(from, to, { recursive: true });
		await rm(from, { recursive: true, force: true });
	}
}

/** Free bytes for unprivileged users on the volume of `dir` (or its nearest existing parent). */
export async function volumeFreeBytes(dir: string): Promise<number> {
	let path = dir;
	for (;;) {
		try {
			const s = await statfs(path);
			return Number(s.bavail) * Number(s.bsize);
		} catch (err) {
			const parent = dirname(path);
			if ((err as { code?: string }).code !== "ENOENT" || parent === path) throw err;
			path = parent;
		}
	}
}

const mb = (bytes: number) => `${Math.ceil(bytes / 1e6)} MB`;
