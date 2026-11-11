import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "../electrobun.config.ts";
import { ACCESSORY_KEYS, infoPlistTargets, isMacBuild, plutilCommands } from "../scripts/mac-accessory.ts";

const bundle = (root: string, name: string) => {
	mkdirSync(join(root, name, "Contents"), { recursive: true });
	writeFileSync(join(root, name, "Contents", "Info.plist"), "<plist/>");
	return join(root, name);
};

describe("GLIM-106 accessory app (LSUIElement)", () => {
	test("the build runs the hook after building and after wrapping", () => {
		expect(config.scripts.postBuild).toBe("scripts/postbuild.ts");
		expect(config.scripts.postWrap).toBe("scripts/postbuild.ts");
		expect(ACCESSORY_KEYS.LSUIElement).toBe(true);
	});

	test("only macOS builds are patched", () => {
		expect(isMacBuild({ ELECTROBUN_OS: "macos" }, "linux")).toBe(true);
		expect(isMacBuild({ ELECTROBUN_OS: "linux" }, "darwin")).toBe(false);
		expect(isMacBuild({ ELECTROBUN_OS: "win" }, "win32")).toBe(false);
		expect(isMacBuild({}, "darwin")).toBe(true);
	});

	test("postBuild: every .app in the build folder", () => {
		const dir = mkdtempSync(join(tmpdir(), "glim-106-"));
		const app = bundle(dir, "Glimpse.app");
		mkdirSync(join(dir, "Resources"));
		expect(infoPlistTargets({ ELECTROBUN_OS: "macos", ELECTROBUN_BUILD_DIR: dir })).toEqual([
			join(app, "Contents", "Info.plist"),
		]);
	});

	test("postWrap: the wrapper bundle only", () => {
		const dir = mkdtempSync(join(tmpdir(), "glim-106-"));
		bundle(dir, "Glimpse.app");
		const wrapper = bundle(join(dir, "wrap"), "Glimpse.app");
		expect(
			infoPlistTargets({ ELECTROBUN_OS: "macos", ELECTROBUN_BUILD_DIR: dir, ELECTROBUN_WRAPPER_BUNDLE_PATH: wrapper }),
		).toEqual([join(wrapper, "Contents", "Info.plist")]);
	});

	test("a missing build folder or plist yields nothing", () => {
		expect(infoPlistTargets({ ELECTROBUN_BUILD_DIR: "/nonexistent/glim-106" })).toEqual([]);
		const dir = mkdtempSync(join(tmpdir(), "glim-106-"));
		mkdirSync(join(dir, "Empty.app"));
		expect(infoPlistTargets({ ELECTROBUN_BUILD_DIR: dir })).toEqual([]);
	});

	test("plutil sets LSUIElement as a boolean", () => {
		expect(plutilCommands("/x/Info.plist")).toEqual([
			["plutil", "-replace", "LSUIElement", "-bool", "YES", "/x/Info.plist"],
		]);
	});
});
