// The cloud spend guard, app side (GLIM-120): the monthly counters in
// `<userData>/cloud-usage.json` and the `CloudUsageGate` the Google providers call. The rules
// are in @glimpse/core (providers/usage.ts).
//
// Never sent anywhere: the file holds this month's totals per API and whether the user chose
// "Continue this month". No screen text, no per-request records.
//
// Counting is in memory and synchronous (`admit` / `record` run inside provider calls); the
// file is written at most once per `saveDelayMs`, and on `flush()` at quit. No electrobun
// imports: tested on Linux.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	addUsage,
	type CloudUsageGate,
	type CloudUsageState,
	type CloudUsageSummary,
	emptyUsage,
	isPaused,
	type Logger,
	type ProviderId,
	parseCloudUsageState,
	rollMonth,
	type SpendCap,
	spendCapError,
	usageMonth,
	usageSummary,
} from "@glimpse/core";

export const CLOUD_USAGE_FILE = "cloud-usage.json";

export interface CloudUsageStore {
	/** The raw JSON, or null when there is no file yet (or it can't be read). */
	load(): Promise<unknown>;
	save(state: CloudUsageState): Promise<void>;
}

export function fileCloudUsageStore(userData: string): CloudUsageStore {
	const path = join(userData, CLOUD_USAGE_FILE);
	return {
		async load() {
			try {
				return JSON.parse(await readFile(path, "utf8")) as unknown;
			} catch {
				return null;
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

export interface CloudUsageDeps {
	readonly store: CloudUsageStore;
	/** `settings.cloud.spendCap`, read on every request. */
	readonly cap: () => SpendCap;
	readonly now?: () => number;
	readonly log: Logger;
	/** Coalesce writes (Live can record several requests a second). Default 2 s. */
	readonly saveDelayMs?: number;
}

export class CloudUsage implements CloudUsageGate {
	readonly #deps: CloudUsageDeps;
	readonly #now: () => number;
	readonly #listeners = new Set<(summary: CloudUsageSummary) => void>();
	#state: CloudUsageState;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#saving: Promise<void> = Promise.resolve();

	constructor(deps: CloudUsageDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#state = emptyUsage(this.#month());
	}

	#month(): string {
		return usageMonth(this.#now());
	}

	/** Read the file once at startup. Counts recorded before it finished are kept on top. */
	async load(): Promise<void> {
		const month = this.#month();
		const loaded = parseCloudUsageState(await this.#deps.store.load(), month);
		const early = rollMonth(this.#state, month);
		let merged = loaded;
		for (const [id, n] of Object.entries(early.counts)) merged = addUsage(merged, id as ProviderId, n, month);
		this.#state = early.continued ? { ...merged, continued: early.continued } : merged;
	}

	get summary(): CloudUsageSummary {
		return usageSummary(this.#state, this.#deps.cap(), this.#month());
	}

	subscribe(listener: (summary: CloudUsageSummary) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Throws `ProviderError("spend-cap")` when the guard has paused this API this month. */
	admit(providerId: ProviderId): void {
		const month = this.#month();
		if (isPaused(this.#state, providerId, this.#deps.cap(), month)) {
			this.#deps.log.debug("cloud request paused by the spend guard", { providerId, month });
			throw spendCapError(providerId);
		}
	}

	record(providerId: ProviderId, units: number): void {
		const next = addUsage(this.#state, providerId, units, this.#month());
		if (next === this.#state) return;
		this.#state = next;
		this.#schedule();
	}

	/** "Continue this month": cloud use resumes until the month ends. */
	async continueThisMonth(): Promise<CloudUsageSummary> {
		const month = this.#month();
		this.#state = { ...rollMonth(this.#state, month), continued: month };
		this.#deps.log.info("spend guard: continue this month", { month });
		await this.flush();
		return this.summary;
	}

	#schedule(): void {
		if (this.#timer !== null) return;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.flush();
		}, this.#deps.saveDelayMs ?? 2_000);
	}

	/** Write now (quit, "Continue this month") and tell listeners. */
	flush(): Promise<void> {
		if (this.#timer !== null) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		const state = this.#state;
		this.#saving = this.#saving
			.then(() => this.#deps.store.save(state))
			.catch((error: unknown) => this.#deps.log.warn("could not save cloud usage", { error }));
		this.#notify();
		return this.#saving;
	}

	#notify(): void {
		const s = this.summary;
		for (const l of [...this.#listeners]) l(s);
	}
}
