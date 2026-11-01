// An in-memory SettingsStore for tests: inspect `contents` and `backups`, inject failures.

import type { BackupReason, SettingsStore } from "../settings/store.ts";

export class MemorySettingsStore implements SettingsStore {
	contents: string | null;
	readonly backups: { reason: BackupReason; contents: string }[] = [];
	writes = 0;
	/** Set to make the next calls fail. */
	failRead: Error | null = null;
	failWrite: Error | null = null;

	constructor(initial: string | null = null) {
		this.contents = initial;
	}

	async read(): Promise<string | null> {
		if (this.failRead) throw this.failRead;
		return this.contents;
	}

	async write(contents: string): Promise<void> {
		if (this.failWrite) throw this.failWrite;
		this.contents = contents;
		this.writes++;
	}

	async backup(reason: BackupReason): Promise<string | null> {
		if (this.contents === null) return null;
		this.backups.push({ reason, contents: this.contents });
		return `memory:${reason}-${this.backups.length}`;
	}

	/** The stored JSON, parsed. */
	json(): unknown {
		return this.contents === null ? null : JSON.parse(this.contents);
	}
}
