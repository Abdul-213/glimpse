import { describe, expect, test } from "bun:test";
import electrobunConfig from "../electrobun.config.ts";
import hutchConfig from "../hutch.config.ts";
import { listViews } from "../scripts/build-views.ts";
import { ELECTROBUN_VERSION } from "../src/bun/electrobun-version.ts";
import { toPlatform } from "../src/bun/platform.ts";

describe("app config", () => {
	test("Electrobun pin matches the version the app reports", () => {
		expect(hutchConfig.electrobun.version).toBe(ELECTROBUN_VERSION);
		expect(ELECTROBUN_VERSION).toBe("2.0.6-beta.2");
	});

	test("tray app keeps running when windows close", () => {
		expect(electrobunConfig.runtime?.exitOnLastWindowClosed).toBe(false);
	});

	test("built views and tray assets are copied into the app", () => {
		expect(electrobunConfig.build?.copy?.["dist/views"]).toBe("views");
		expect(electrobunConfig.build?.copy?.["assets/tray"]).toBe("views/assets");
	});

	test("settings view exists", () => {
		expect(listViews()).toContain("settings");
	});
});

describe("platform", () => {
	test("maps Node platform names", () => {
		expect(toPlatform("darwin")).toBe("macos");
		expect(toPlatform("win32")).toBe("windows");
		expect(toPlatform("linux")).toBe("linux");
		expect(toPlatform("freebsd")).toBe("linux");
	});
});
