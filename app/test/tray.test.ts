import { describe, expect, test } from "bun:test";
import { createLogger } from "@glimpse/core";
import { MemoryLogSink } from "@glimpse/core/testing";
import { COMMANDS, CommandBus, isCommand } from "../src/bun/commands.ts";
import { parseTaskbarTheme, readTaskbarTheme, watchTaskbarTheme } from "../src/bun/services/taskbar-theme.ts";
import {
	buildTrayMenu,
	hotkeyLabel,
	TrayController,
	type TrayMenuItem,
	type TrayState,
	trayIconFor,
} from "../src/bun/tray-menu.ts";

const base: TrayState = {
	platform: "windows",
	live: "off",
	private: false,
	translation: { name: "Bergamot", kind: "local" },
	hotkeys: { snip: "Alt+Shift+S", live: "Alt+Shift+L" },
	taskbarTheme: "dark",
};

type Normal = Extract<TrayMenuItem, { type: "normal" }>;
const normal = (menu: TrayMenuItem[]) => menu.filter((i): i is Normal => i.type === "normal");
const labels = (menu: TrayMenuItem[]) => normal(menu).map((i) => i.label);
const actions = (menu: TrayMenuItem[]) => normal(menu).flatMap((i) => (i.action ? [i.action] : []));
const byAction = (menu: TrayMenuItem[], action: string) => normal(menu).find((i) => i.action === action);

describe("tray menu", () => {
	test("idle, local, Windows (flow T1)", () => {
		const menu = buildTrayMenu(base);
		expect(labels(menu)).toEqual([
			"Glimpse · on this computer",
			"Translator: Bergamot",
			"Snip\tAlt+Shift+S",
			"Live: pin a region\tAlt+Shift+L",
			"Private",
			"Clear translation cache",
			"Settings…",
			"Troubleshooting",
			"Quit Glimpse",
		]);
		expect(normal(menu)[0]?.enabled).toBe(false);
		expect(actions(menu)).toEqual([
			"snip.start",
			"live.start",
			"private.toggle",
			"cache.clear",
			"settings.open",
			"app.quit",
		]);
		const sub = byAction(menu, "settings.open") && normal(menu).find((i) => i.label === "Troubleshooting")?.submenu;
		expect(sub?.map((i) => (i.type === "normal" ? i.action : null))).toEqual(["diagnostics.copy", "logs.open"]);
	});

	test("macOS: Title Case, this Mac, no tab shortcuts", () => {
		const menu = buildTrayMenu({ ...base, platform: "macos", hotkeys: { snip: "Ctrl+Shift+S", live: "Ctrl+Shift+L" } });
		expect(labels(menu)).toContain("Glimpse · on this Mac");
		expect(labels(menu)).toContain("Live: Pin a Region");
		expect(labels(menu)).toContain("Clear Translation Cache");
		expect(labels(menu)).toContain("Snip");
		expect(labels(menu).some((l) => l.includes("\t"))).toBe(false);
	});

	test("Live running and paused (flow T2)", () => {
		const running = buildTrayMenu({ ...base, live: "running" });
		expect(labels(running)[0]).toBe("● Live is watching a region · on this computer");
		expect(actions(running)).toContain("live.pause");
		expect(byAction(running, "live.stop")?.label).toBe("Stop Live\tAlt+Shift+L");
		expect(actions(running)).not.toContain("live.start");
		const paused = buildTrayMenu({ ...base, live: "paused" });
		expect(labels(paused)[0]).toBe("❚❚ Live is paused · on this computer");
		expect(actions(paused)).toContain("live.resume");
		// GLIM-81: the popup's tray mirrors (live-popup.md §6.3).
		expect(byAction(running, "live.popup.toggle")?.label).toBe("Hide Live popup");
		expect(byAction(running, "live.popup.focus")?.label).toBe("Focus Live popup");
		expect(
			byAction(buildTrayMenu({ ...base, live: "running", livePopupHidden: true }), "live.popup.toggle")?.label,
		).toBe("Show Live popup");
	});

	test("cloud provider is named in the status line (flow T3)", () => {
		const menu = buildTrayMenu({ ...base, translation: { name: "Google Translate", kind: "cloud" } });
		expect(labels(menu)[0]).toBe("Glimpse · translating with ☁ Google Translate (cloud)");
		expect(labels(menu)[1]).toBe("Translator: Google Translate (cloud)");
	});

	test("cloud OCR is named too (GLIM-80)", () => {
		const menu = buildTrayMenu({ ...base, cloudOcr: "Google Cloud Vision" });
		expect(labels(menu)[0]).toBe("Glimpse · reading text with ☁ Google Cloud Vision (cloud)");
		expect(labels(menu)[1]).toBe("Translator: Bergamot · Text reading: Google Cloud Vision (cloud)");
		const both = buildTrayMenu({
			...base,
			live: "running",
			cloudOcr: "Google Cloud Vision",
			translation: { name: "Google Translate", kind: "cloud" },
		});
		expect(labels(both)[0]).toBe("● Live is watching a region · ☁ Google Translate (cloud)");
	});

	test("no provider and unset hotkeys", () => {
		const menu = buildTrayMenu({ ...base, translation: null, hotkeys: { snip: null, live: null } });
		expect(labels(menu)[1]).toBe("No translation provider installed");
		expect(byAction(menu, "snip.start")?.label).toBe("Snip");
	});

	test("Private is a checkbox item", () => {
		expect(byAction(buildTrayMenu(base), "private.toggle")?.checked).toBe(false);
		expect(byAction(buildTrayMenu({ ...base, private: true }), "private.toggle")?.checked).toBe(true);
	});

	test("every menu action is a known command", () => {
		const all = (m: readonly TrayMenuItem[]): string[] =>
			m.flatMap((i) => (i.type === "normal" ? [...(i.action ? [i.action] : []), ...all(i.submenu ?? [])] : []));
		for (const a of all(buildTrayMenu({ ...base, live: "running" }))) expect(isCommand(a)).toBe(true);
	});

	test("hotkey labels", () => {
		expect(hotkeyLabel("macos", "Ctrl+Shift+S")).toBe("⌃⇧S");
		expect(hotkeyLabel("macos", "Alt+Cmd+L")).toBe("⌥⌘L");
		expect(hotkeyLabel("windows", "Alt+Shift+S")).toBe("Alt+Shift+S");
	});
});

describe("tray icon", () => {
	test("macOS template, Windows follows the taskbar", () => {
		expect(trayIconFor("macos")).toEqual({ image: "views://assets/tray-template.png", template: true });
		expect(trayIconFor("windows", "dark").image).toBe("views://assets/tray-light.png");
		expect(trayIconFor("windows", "light").image).toBe("views://assets/tray-dark.png");
		expect(trayIconFor("linux").image).toBe("views://assets/tray-dark.png");
	});
});

describe("TrayController", () => {
	test("rebuilds only on change; swaps the icon when the taskbar theme flips", () => {
		const menus: TrayMenuItem[][] = [];
		const images: string[] = [];
		const c = new TrayController({ setMenu: (m) => menus.push(m), setImage: (i) => images.push(i) }, base);
		expect(menus).toHaveLength(1);
		c.update({ taskbarTheme: "dark" });
		expect(menus).toHaveLength(1);
		c.update({ private: true });
		expect(menus).toHaveLength(2);
		expect(images).toEqual([]);
		c.update({ taskbarTheme: "light" });
		expect(images).toEqual(["views://assets/tray-dark.png"]);
		expect(menus).toHaveLength(2);
		expect(c.state.private).toBe(true);
	});
});

describe("CommandBus", () => {
	const setup = () => {
		const sink = new MemoryLogSink();
		return { sink, bus: new CommandBus(createLogger({ sinks: [sink], level: "debug" })) };
	};

	test("dispatches to the one handler with its source", async () => {
		const { bus } = setup();
		const seen: string[] = [];
		const off = bus.handle("snip.start", (source) => {
			seen.push(source);
		});
		expect(await bus.dispatch("snip.start", "tray")).toBe(true);
		expect(seen).toEqual(["tray"]);
		expect(() => bus.handle("snip.start", () => {})).toThrow();
		off();
		expect(bus.has("snip.start")).toBe(false);
	});

	test("unhandled and failing commands are logged, never thrown", async () => {
		const { bus, sink } = setup();
		expect(await bus.dispatch("live.start", "hotkey")).toBe(false);
		bus.handle("cache.clear", async () => {
			throw new Error("boom");
		});
		expect(await bus.dispatch("cache.clear")).toBe(false);
		expect(sink.at("warn")[0]?.fields).toEqual({ command: "live.start", source: "hotkey" });
		expect(sink.at("error")[0]?.message).toBe("command failed");
	});

	test("command list", () => {
		expect(COMMANDS).toContain("private.toggle");
		expect(isCommand("nope")).toBe(false);
	});
});

describe("Windows taskbar theme", () => {
	const out = (v: string) =>
		`\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\r\n    SystemUsesLightTheme    REG_DWORD    ${v}\r\n\r\n`;

	test("parses reg query output", () => {
		expect(parseTaskbarTheme(out("0x1"))).toBe("light");
		expect(parseTaskbarTheme(out("0x0"))).toBe("dark");
		expect(parseTaskbarTheme("ERROR: The system was unable to find the specified registry key or value.")).toBeNull();
	});

	test("missing value or failing reg.exe means a dark taskbar", async () => {
		expect(await readTaskbarTheme(async () => ({ exitCode: 1, stdout: "" }))).toBe("dark");
		expect(
			await readTaskbarTheme(async () => {
				throw new Error("ENOENT");
			}),
		).toBe("dark");
		expect(await readTaskbarTheme(async () => ({ exitCode: 0, stdout: out("0x1") }))).toBe("light");
	});

	test("watcher reports the first value and changes only", async () => {
		const values = ["0x0", "0x0", "0x1"];
		const seen: string[] = [];
		const w = watchTaskbarTheme((t) => seen.push(t), {
			intervalMs: 5,
			run: async () => ({ exitCode: 0, stdout: out(values.shift() ?? "0x1") }),
		});
		await new Promise((r) => setTimeout(r, 40));
		w.stop();
		expect(seen).toEqual(["dark", "light"]);
	});
});
