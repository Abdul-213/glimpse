// GLIM-116 / GLIM-110: window materials, cloaked hide, popup edges and theme, with a fake native side.

import type { Pointer } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import type { Rect } from "@glimpse/core";
import type { NativeMaterial, ThemeSetting, WindowChromeNative } from "../src/bun/native/chrome.ts";
import {
	type ChromeTarget,
	domChromeScript,
	nativeDark,
	planChrome,
	themeOverride,
	WindowChrome,
	wantsTransparentWindow,
} from "../src/bun/windows/window-chrome.ts";

describe("planChrome", () => {
	const mac = { os: "macos" as const, windowsBuild: null, reduceTransparency: false };
	test("macOS popup: popover effect view, 12 px mask", () => {
		expect(planChrome("popup", mac)).toEqual({
			material: "native",
			native: { kind: "mac-effect", material: 6, radius: 12 },
			osVersion: null,
		});
	});
	test("reduced transparency: solid veil, no material", () => {
		expect(planChrome("popup", { ...mac, reduceTransparency: true })).toEqual({
			material: "none",
			native: { kind: "none" },
			osVersion: null,
		});
	});
	test("Windows 11 22H2+: Acrylic with round corners; 21H2 solid; Windows 10 square", () => {
		const win = (build: number) =>
			planChrome("popup", { os: "windows", windowsBuild: build, reduceTransparency: false });
		expect(win(22631)).toEqual({
			material: "native",
			native: { kind: "win-backdrop", backdrop: 3, corner: 2 },
			osVersion: "11",
		});
		expect(win(22000)).toMatchObject({ material: "none", osVersion: "11" });
		expect(win(19045)).toMatchObject({ material: "none", native: { kind: "none" }, osVersion: "10" });
	});
	test("Settings-type windows get no material", () => {
		expect(planChrome("window", mac).material).toBe("none");
	});
	test("transparent windows only where a material can show through", () => {
		expect(wantsTransparentWindow("popup", "macos", null)).toBe(true);
		expect(wantsTransparentWindow("popup", "windows", 22621)).toBe(true);
		expect(wantsTransparentWindow("popup", "windows", 19045)).toBe(false);
		expect(wantsTransparentWindow("window", "macos", null)).toBe(false);
		expect(wantsTransparentWindow("popup", "linux", null)).toBe(false);
	});
});

describe("theme resolution", () => {
	test("override and native dark", () => {
		expect([themeOverride("system"), themeOverride("light"), themeOverride("dark")]).toEqual([null, "light", "dark"]);
		expect(nativeDark("system", true)).toBe(true);
		expect(nativeDark("system", null)).toBe(false);
		expect(nativeDark("light", true)).toBe(false);
		expect(nativeDark("dark", false)).toBe(true);
	});
	test("the DOM script sets and removes the attributes", () => {
		const html = { attrs: new Map<string, string>() };
		const run = (js: string) => {
			const d = {
				setAttribute: (k: string, v: string) => html.attrs.set(k, v),
				removeAttribute: (k: string) => html.attrs.delete(k),
			};
			new Function("document", js)({ documentElement: d });
		};
		run(domChromeScript({ material: "native", osVersion: "11", theme: "dark" }));
		expect(Object.fromEntries(html.attrs)).toEqual({
			"data-material": "native",
			"data-os-version": "11",
			"data-theme": "dark",
		});
		run(domChromeScript({ material: "none", osVersion: null, theme: null }));
		expect(Object.fromEntries(html.attrs)).toEqual({ "data-material": "none", "data-os-version": "11" });
	});
});

class FakeNative implements WindowChromeNative {
	calls: string[] = [];
	reduce = false;
	dark: boolean | null = false;
	build: number | null = 22631;
	failCloak = false;
	reduceTransparency(): boolean {
		return this.reduce;
	}
	systemDark(): boolean | null {
		return this.dark;
	}
	windowsBuild(): number | null {
		return this.build;
	}
	setMaterial(_w: Pointer, m: NativeMaterial): void {
		this.calls.push(`material ${m.kind}`);
	}
	setAppearance(_w: Pointer, theme: ThemeSetting, dark: boolean): void {
		this.calls.push(`appearance ${theme} ${dark ? "dark" : "light"}`);
	}
	setCloaked(_w: Pointer, cloaked: boolean): void {
		if (this.failCloak) throw new Error("DWMWA_CLOAK failed");
		this.calls.push(`cloak ${cloaked}`);
	}
	disableResize(): void {
		this.calls.push("no-resize");
	}
	setFrame(_w: Pointer, f: Rect): void {
		this.calls.push(`frame ${f.x},${f.y} ${f.width}x${f.height}`);
	}
}

function target() {
	const scripts: string[] = [];
	let ready: (() => void) | null = null;
	const t: ChromeTarget = {
		handle: 1 as Pointer,
		runScript: (js) => scripts.push(js),
		onDomReady: (l) => {
			ready = l;
		},
	};
	return { t, scripts, reload: () => ready?.() };
}

describe("WindowChrome", () => {
	test("attach applies material, appearance and DOM attributes; reloads get them again", () => {
		const native = new FakeNative();
		let theme: ThemeSetting = "system";
		const chrome = new WindowChrome({ os: "windows", native, theme: () => theme, log: () => {} });
		const { t, scripts, reload } = target();
		const h = chrome.attach(t, "popup");
		expect(native.calls).toEqual(["material win-backdrop", "appearance system light"]);
		expect(scripts.at(-1)).toContain('"data-material","native"');
		expect(scripts.at(-1)).toContain('removeAttribute("data-theme")');
		const n = scripts.length;
		reload();
		expect(scripts).toHaveLength(n + 1);

		// GLIM-110: a theme change reaches every window at once.
		theme = "dark";
		chrome.themeChanged();
		expect(native.calls.at(-1)).toBe("appearance dark dark");
		expect(scripts.at(-1)).toContain('"data-theme","dark"');
		h.dispose();
		chrome.themeChanged();
		expect(native.calls.at(-1)).toBe("appearance dark dark");
	});

	test("refresh follows reduced transparency, and only re-applies what changed", () => {
		const native = new FakeNative();
		const chrome = new WindowChrome({ os: "macos", native, theme: () => "system", log: () => {} });
		native.build = null;
		const { t, scripts } = target();
		const h = chrome.attach(t, "popup");
		native.calls = [];
		const before = scripts.length;
		h.refresh();
		expect(native.calls).toEqual([]);
		expect(scripts).toHaveLength(before);
		native.reduce = true;
		expect(h.refresh().material).toBe("none");
		expect(native.calls).toEqual(["material none"]);
		expect(scripts.at(-1)).toContain('"data-material","none"');
	});

	test("Windows popups cloak; a refused cloak falls back to hide", () => {
		const native = new FakeNative();
		const chrome = new WindowChrome({ os: "windows", native, theme: () => "system", log: () => {} });
		const h = chrome.attach(target().t, "popup");
		expect(h.canCloak).toBe(true);
		expect(h.setCloaked(true)).toBe(true);
		expect(h.cloaked).toBe(true);
		expect(h.setCloaked(false)).toBe(true);
		native.failCloak = true;
		expect(h.setCloaked(true)).toBe(false);
		expect(h.cloaked).toBe(false);
		expect(h.disableResize()).toBe(true);
		expect(h.setFrame({ x: 0, y: 0, width: 1, height: 1 })).toBe(false); // Electrobun's setFrame on Windows
	});

	test("macOS: native setFrame, no cloak; Settings windows only get the theme", () => {
		const native = new FakeNative();
		native.build = null;
		const chrome = new WindowChrome({ os: "macos", native, theme: () => "light", log: () => {} });
		const popup = chrome.attach(target().t, "popup");
		expect(popup.canCloak).toBe(false);
		expect(popup.setFrame({ x: 10, y: 20, width: 300, height: 120 })).toBe(true);
		expect(native.calls.at(-1)).toBe("frame 10,20 300x120");
		native.calls = [];
		const { t, scripts } = target();
		chrome.attach(t, "window");
		expect(native.calls).toEqual(["material none", "appearance light light"]);
		expect(scripts.at(-1)).toContain('"data-theme","light"');
	});

	test("no helper (Linux): DOM attributes only; native failures are logged, not thrown", () => {
		const logs: string[] = [];
		const chrome = new WindowChrome({ os: "linux", native: null, theme: () => "system", log: (m) => logs.push(m) });
		const { t, scripts } = target();
		const h = chrome.attach(t, "popup");
		expect(scripts.at(-1)).toContain('"data-material","none"');
		expect(h.setCloaked(true)).toBe(false);

		const native = new FakeNative();
		native.setMaterial = () => {
			throw new Error("not an NSWindow");
		};
		const mac = new WindowChrome({ os: "macos", native, theme: () => "system", log: (m) => logs.push(m) });
		expect(() => mac.attach(target().t, "popup")).not.toThrow();
		expect(logs.some((l) => l.includes("material failed"))).toBe(true);
	});
});
