// Update notification (GLIM-70): at most once a day, ask GitHub for the latest published
// release; if it is newer than this build, the tray and Settings › About say so and link to
// the release page. Notify only: nothing is downloaded or installed.
//
// What leaves the machine: one HTTPS GET to api.github.com (with a "Glimpse/<version>"
// User-Agent, as GitHub's API requires), never screen text, settings or identifiers. Off with
// Settings › About › "Check for updates" (`settings.updates.check`).
//
// Every failure is quiet: offline, rate-limited, a 404 (the repository is private today, so
// the API answers 404 to anonymous requests) or a malformed reply only logs at debug level and
// counts as a check, so it is retried the next day, not on every start.
//
// No electrobun imports: the composition root passes fetch, the state file and the clock.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	EMPTY_UPDATE_STATE,
	isCheckDue,
	LATEST_RELEASE_URL,
	type Logger,
	parseLatestRelease,
	parseUpdateCheckState,
	type UpdateCheckState,
	type UpdateStatus,
	updateStatus,
} from "@glimpse/core";

export const UPDATE_STATE_FILE = "update-check.json";

/** Where the last check's result lives between runs (not in settings.json: it isn't a setting). */
export interface UpdateStateStore {
	load(): Promise<UpdateCheckState>;
	save(state: UpdateCheckState): Promise<void>;
}

export function fileUpdateStateStore(userData: string): UpdateStateStore {
	const path = join(userData, UPDATE_STATE_FILE);
	return {
		async load() {
			try {
				return parseUpdateCheckState(JSON.parse(await readFile(path, "utf8")));
			} catch {
				return EMPTY_UPDATE_STATE;
			}
		},
		async save(state) {
			await mkdir(dirname(path), { recursive: true });
			const tmp = `${path}.${process.pid}.tmp`;
			await writeFile(tmp, `${JSON.stringify(state)}\n`);
			await rename(tmp, path);
		},
	};
}

export interface UpdateCheckerDeps {
	readonly currentVersion: string;
	/** `settings.updates.check`, read on every tick. */
	readonly enabled: () => boolean;
	readonly store: UpdateStateStore;
	readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
	readonly now?: () => number;
	readonly log: Logger;
	readonly timeoutMs?: number;
}

export type UpdateListener = (status: UpdateStatus) => void;

export class UpdateChecker {
	readonly #deps: UpdateCheckerDeps;
	readonly #now: () => number;
	readonly #listeners = new Set<UpdateListener>();
	#state: UpdateCheckState = EMPTY_UPDATE_STATE;
	#loaded: Promise<void> | null = null;
	#inFlight: Promise<UpdateStatus> | null = null;
	#lastKey = "";

	constructor(deps: UpdateCheckerDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
	}

	get status(): UpdateStatus {
		return updateStatus(this.#state, this.#deps.currentVersion, this.#deps.enabled());
	}

	subscribe(listener: UpdateListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Load the stored state (once) and tell listeners what it says. */
	async load(): Promise<UpdateStatus> {
		this.#loaded ??= this.#deps.store.load().then((s) => {
			this.#state = s;
		});
		await this.#loaded;
		this.#emit();
		return this.status;
	}

	/** Call when `settings.updates.check` changes, so the tray and About follow at once. */
	settingsChanged(): void {
		this.#emit();
	}

	/** Check GitHub if enabled and a day has passed since the last attempt. Never throws. */
	checkIfDue(): Promise<UpdateStatus> {
		this.#inFlight ??= this.#run().finally(() => {
			this.#inFlight = null;
		});
		return this.#inFlight;
	}

	async #run(): Promise<UpdateStatus> {
		await this.load();
		const now = this.#now();
		if (!isCheckDue(this.#state, now, this.#deps.enabled())) return this.status;
		let latest = this.#state.latest;
		try {
			const res = await this.#deps.fetch(LATEST_RELEASE_URL, {
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": `Glimpse/${this.#deps.currentVersion}`,
					"X-GitHub-Api-Version": "2022-11-28",
				},
				signal: AbortSignal.timeout(this.#deps.timeoutMs ?? 15_000),
			});
			if (res.ok) {
				const found = parseLatestRelease(await res.json());
				if (found) latest = found;
				else this.#deps.log.debug("update check: no usable release in the reply");
			} else if (res.status === 404) {
				// No published release yet, or the repository isn't public.
				this.#deps.log.debug("update check: no public release found", { status: res.status });
			} else {
				this.#deps.log.debug("update check failed", { status: res.status });
			}
		} catch (error) {
			this.#deps.log.debug("update check failed", { error: error instanceof Error ? error.message : String(error) });
		}
		this.#state = { lastCheckAt: now, latest };
		try {
			await this.#deps.store.save(this.#state);
		} catch (error) {
			this.#deps.log.debug("could not save the update check state", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		this.#emit();
		return this.status;
	}

	#emit(): void {
		const status = this.status;
		const key = JSON.stringify(status);
		if (key === this.#lastKey) return;
		this.#lastKey = key;
		for (const l of this.#listeners) l(status);
	}
}
