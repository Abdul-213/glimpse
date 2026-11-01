// The live settings (GLIM-69): the one in-memory copy the main process owns, changed only
// through `update`, saved through the core SettingsStore port, and announced to subscribers
// (log level, tray, hotkeys, Settings windows) so changes apply without a restart.
//
// No electrobun imports: tested on Linux with MemorySettingsStore.
import {
	applySettingsPatch,
	type Issue,
	type Logger,
	type Settings,
	type SettingsEnv,
	type SettingsPatch,
	type SettingsStore,
	saveSettings,
} from "@glimpse/core";

export type SettingsListener = (next: Settings, previous: Settings) => void;

export class AppSettings {
	#current: Settings;
	readonly #store: SettingsStore;
	readonly #env: SettingsEnv;
	readonly #log: Logger | null;
	readonly #listeners = new Set<SettingsListener>();
	/** Saves run one after another, so the file always ends with the latest settings. */
	#saving: Promise<void> = Promise.resolve();

	constructor(initial: Settings, store: SettingsStore, env: SettingsEnv, log: Logger | null = null) {
		this.#current = initial;
		this.#store = store;
		this.#env = env;
		this.#log = log;
	}

	get current(): Settings {
		return this.#current;
	}

	get env(): SettingsEnv {
		return this.#env;
	}

	/**
	 * Apply a patch: invalid fields keep their value and come back as issues. Valid changes are
	 * applied at once, then saved; a failed save is logged (the change still applies for this
	 * run, and the next save retries).
	 */
	async update(patch: SettingsPatch): Promise<{ settings: Settings; issues: Issue[] }> {
		const previous = this.#current;
		const { settings, issues } = applySettingsPatch(previous, patch, this.#env);
		for (const issue of issues)
			this.#log?.warn("settings change rejected", { path: issue.path, reason: issue.message });
		if (JSON.stringify(settings) === JSON.stringify(previous)) return { settings, issues };
		this.#current = settings;
		for (const listener of [...this.#listeners]) {
			try {
				listener(settings, previous);
			} catch (error) {
				this.#log?.error("settings listener failed", { error });
			}
		}
		await this.#save(settings);
		return { settings, issues };
	}

	subscribe(listener: SettingsListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Resolves once every save started so far has finished. */
	flush(): Promise<void> {
		return this.#saving;
	}

	#save(settings: Settings): Promise<void> {
		this.#saving = this.#saving.then(async () => {
			// A later update may already be queued; write whatever is current when our turn comes.
			if (settings !== this.#current) return;
			try {
				await saveSettings(this.#store, settings);
			} catch (error) {
				this.#log?.error("could not save settings", { error });
			}
		});
		return this.#saving;
	}
}
