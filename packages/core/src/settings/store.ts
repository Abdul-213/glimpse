// The SettingsStore port and the load/save policy around it.
//
// The app implements the port with a file in the user data dir
// (app/src/bun/services/settings-store.ts: atomic replace, backups); tests use
// `MemorySettingsStore` from @glimpse/core/testing. All the decisions live here, in pure
// code: what counts as corrupt, when to back up, when to rewrite the file.
//
//   no file           -> defaults (first run); nothing written until the first save
//   unreadable JSON   -> back up the file ("corrupt"), defaults, write them, warn
//   older version     -> back up ("pre-migration"), migrate, write the result
//   failed migration  -> back up ("corrupt"), defaults, write them, warn
//   newer version     -> back up ("newer-version"), load what we understand, warn; the
//                        next save writes our version (the backup keeps the newer file)
//   bad field values  -> that field takes its default, warn; the file is left as is
//                        until the next save, so a hand-edit isn't rewritten behind the user

import { formatIssue, isPlainObject, type JsonObject } from "../schema/index.ts";
import { classifyVersion, fileVersion, type Migration, runMigrations, SETTINGS_MIGRATIONS } from "./migrations.ts";
import {
	defaultSettings,
	parseSettings,
	SETTINGS_VERSION,
	type Settings,
	type SettingsEnv,
	serializeSettings,
} from "./schema.ts";

export type BackupReason = "corrupt" | "pre-migration" | "newer-version";

export interface SettingsStore {
	/** The file's text, or null when there is none yet. Throws on other read errors. */
	read(): Promise<string | null>;
	/** Replace the contents atomically: after a crash, readers see the old or the new text, never a mix. */
	write(contents: string): Promise<void>;
	/** Copy the current contents aside; returns where (for the warning), or null if there was nothing. */
	backup(reason: BackupReason): Promise<string | null>;
}

export interface LoadedSettings {
	readonly settings: Settings;
	/** How the settings were obtained. */
	readonly source: "defaults" | "file" | "migrated" | "recovered";
	/** Human-readable, for the log and diagnostics. Never contains secrets (settings hold none). */
	readonly warnings: readonly string[];
	/** The version the file had, if it had to be migrated or was newer. */
	readonly fileVersion: number | null;
	readonly backups: readonly string[];
}

export interface LoadOptions {
	/** For tests: pretend the current schema version is this. */
	readonly version?: number;
	readonly migrations?: readonly Migration[];
}

export async function loadSettings(
	store: SettingsStore,
	env: SettingsEnv,
	options: LoadOptions = {},
): Promise<LoadedSettings> {
	const version = options.version ?? SETTINGS_VERSION;
	const migrations = options.migrations ?? SETTINGS_MIGRATIONS;
	const warnings: string[] = [];
	const backups: string[] = [];
	const backup = async (reason: BackupReason) => {
		try {
			const where = await store.backup(reason);
			if (where) backups.push(where);
			return where;
		} catch (error) {
			warnings.push(`could not back up the settings file: ${message(error)}`);
			return null;
		}
	};
	const write = async (settings: Settings) => {
		try {
			await store.write(serializeSettings(settings, version));
		} catch (error) {
			warnings.push(`could not write the settings file: ${message(error)}`);
		}
	};
	const recover = async (why: string): Promise<LoadedSettings> => {
		const where = await backup("corrupt");
		warnings.push(`${why}; using default settings${where ? ` (the old file was kept at ${where})` : ""}`);
		const settings = defaultSettings(env);
		await write(settings);
		return { settings, source: "recovered", warnings, fileVersion: null, backups };
	};

	let text: string | null;
	try {
		text = await store.read();
	} catch (error) {
		// Don't back up or overwrite a file we couldn't read: it may be fine (locked by a
		// sync client, permissions). Run on defaults; the next save will try to write.
		warnings.push(`could not read the settings file: ${message(error)}; using default settings`);
		return { settings: defaultSettings(env), source: "recovered", warnings, fileVersion: null, backups };
	}
	if (text === null)
		return { settings: defaultSettings(env), source: "defaults", warnings, fileVersion: null, backups };

	let raw: unknown;
	try {
		raw = JSON.parse(text.replace(/^﻿/, ""));
	} catch (error) {
		return recover(`the settings file is not valid JSON (${message(error)})`);
	}
	if (!isPlainObject(raw)) return recover("the settings file does not contain an object");
	let data = raw as JsonObject;

	const info = classifyVersion(fileVersion(data), version);
	let source: LoadedSettings["source"] = "file";
	if (info.kind === "older") {
		try {
			data = runMigrations(data, migrations, version).data;
		} catch (error) {
			return recover(message(error));
		}
		await backup("pre-migration");
		source = "migrated";
	} else if (info.kind === "newer") {
		const where = await backup("newer-version");
		warnings.push(
			`the settings file is from a newer Glimpse (version ${info.version}); loaded what this version understands` +
				(where ? `, the original is kept at ${where}` : ""),
		);
	}

	const { settings, issues } = parseSettings(data, env);
	for (const issue of issues) warnings.push(`settings ${formatIssue(issue)}`);
	if (source === "migrated") await write(settings);
	return {
		settings,
		source,
		warnings,
		fileVersion: info.kind === "current" ? null : info.version,
		backups,
	};
}

export async function saveSettings(store: SettingsStore, settings: Settings): Promise<void> {
	await store.write(serializeSettings(settings));
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
