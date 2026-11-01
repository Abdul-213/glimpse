import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applySettingsPatch,
	defaultSettings,
	languageCode,
	loadSettings,
	ProviderRegistry,
	saveSettings,
} from "@glimpse/core";
import { settingsEnvFor } from "../src/bun/services/settings-env.ts";
import { FileSettingsStore } from "../src/bun/services/settings-store.ts";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "glimpse-settings-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const env = settingsEnvFor("windows", "de-DE", new ProviderRegistry());
let clock = Date.UTC(2026, 10, 1, 12, 0, 0);
const now = () => clock++;

describe("FileSettingsStore", () => {
	test("read returns null when there is no file", async () => {
		expect(await new FileSettingsStore(join(dir, "nested", "settings.json")).read()).toBeNull();
	});

	test("write creates the directory, replaces atomically and leaves no temp files", async () => {
		const store = FileSettingsStore.inDirectory(join(dir, "userData"));
		await store.write("one");
		await store.write("two");
		expect(await store.read()).toBe("two");
		expect(await readdir(join(dir, "userData"))).toEqual(["settings.json"]);
	});

	test("a failed rename removes the temp file and keeps the old contents", async () => {
		const failing = new FileSettingsStore(join(dir, "settings.json"), {
			rename: async () => {
				throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
			},
		});
		await writeFile(join(dir, "settings.json"), "old");
		await expect(failing.write("new")).rejects.toThrow("EXDEV");
		expect(await readFile(join(dir, "settings.json"), "utf8")).toBe("old");
		expect(await readdir(dir)).toEqual(["settings.json"]);
	});

	test("on Windows a transient EPERM on rename is retried", async () => {
		let failures = 2;
		const real = (await import("node:fs/promises")).rename;
		const store = new FileSettingsStore(join(dir, "settings.json"), {
			platform: "win32",
			sleep: async () => {},
			rename: async (from, to) => {
				if (failures-- > 0) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
				await real(from, to);
			},
		});
		await store.write("ok");
		expect(await store.read()).toBe("ok");
		expect(failures).toBe(-1);
	});

	test("backups copy the file and keep the newest few per reason", async () => {
		const store = new FileSettingsStore(join(dir, "settings.json"), { now, keepBackups: 2 });
		expect(await store.backup("corrupt")).toBeNull(); // nothing to back up yet
		await store.write("v");
		const paths: (string | null)[] = [];
		for (let i = 0; i < 4; i++) paths.push(await store.backup("corrupt"));
		await store.backup("pre-migration");
		const names = (await readdir(dir)).sort();
		expect(names.filter((n) => n.includes(".corrupt-"))).toHaveLength(2);
		expect(names.filter((n) => n.includes(".pre-migration-"))).toHaveLength(1);
		const last = paths.at(-1);
		expect(last && (await readFile(last, "utf8"))).toBe("v");
	});
});

describe("settings on disk (core policy + file store)", () => {
	test("settings survive a restart", async () => {
		const first = FileSettingsStore.inDirectory(dir);
		const initial = await loadSettings(first, env);
		expect(initial.source).toBe("defaults");
		expect(initial.settings.language.target).toBe(languageCode("de"));
		const changed = applySettingsPatch(initial.settings, { live: { fps: 2 }, onboarding: { completed: true } }, env);
		await saveSettings(first, changed.settings);

		const second = FileSettingsStore.inDirectory(dir); // a new process
		const reloaded = await loadSettings(second, env);
		expect(reloaded.source).toBe("file");
		expect(reloaded.settings).toEqual(changed.settings);
	});

	test("a corrupt file is kept as a backup and replaced with defaults", async () => {
		await writeFile(join(dir, "settings.json"), "{ not json");
		const loaded = await loadSettings(new FileSettingsStore(join(dir, "settings.json"), { now }), env);
		expect(loaded.source).toBe("recovered");
		expect(loaded.settings).toEqual(defaultSettings(env));
		expect(loaded.backups).toHaveLength(1);
		const backup = loaded.backups[0];
		expect(backup && (await readFile(backup, "utf8"))).toBe("{ not json");
		expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).version).toBe(1);
	});
});

test("settingsEnvFor picks GLIM-23 hotkeys per OS", () => {
	const reg = new ProviderRegistry();
	expect(defaultSettings(settingsEnvFor("macos", "ja-JP", reg)).hotkeys.snip).toBe("Ctrl+Shift+S");
	expect(defaultSettings(settingsEnvFor("windows", "ja-JP", reg)).hotkeys.snip).toBe("Alt+Shift+S");
	expect(defaultSettings(settingsEnvFor("linux", undefined, reg)).language.target).toBe(languageCode("en"));
});
