// GLIM-136: the tray item's accessible name and how each OS gets it.
import { describe, expect, test } from "bun:test";
import { type TrayLabelNative, trayAccessibleNameSetter } from "../src/bun/native/tray-label.ts";
import { TrayController, type TrayMenuItem, type TrayState, trayAccessibleName } from "../src/bun/tray-menu.ts";

const base: TrayState = {
	platform: "macos",
	live: "off",
	private: false,
	translation: { name: "Bergamot", kind: "local" },
	hotkeys: { snip: "Alt+Shift+S", live: "Alt+Shift+L" },
	taskbarTheme: "dark",
};

describe("trayAccessibleName", () => {
	test("names the app and the Live state", () => {
		expect(trayAccessibleName(base)).toBe("Glimpse");
		expect(trayAccessibleName({ ...base, live: "running" })).toBe("Glimpse — Live running");
		expect(trayAccessibleName({ ...base, live: "paused" })).toBe("Glimpse — Live paused");
	});

	test("fits a Windows tooltip", () => {
		for (const live of ["off", "running", "paused"] as const)
			expect(trayAccessibleName({ ...base, live }).length).toBeLessThan(128);
	});
});

describe("TrayController accessible name", () => {
	const host = () => {
		const names: string[] = [];
		return {
			names,
			host: {
				setMenu: (_: TrayMenuItem[]) => {},
				setImage: (_: string) => {},
				setAccessibleName: (n: string) => names.push(n),
			},
		};
	};

	test("set at creation and pushed only when it changes", () => {
		const h = host();
		const c = new TrayController(h.host, base);
		expect(h.names).toEqual(["Glimpse"]);
		c.update({ private: true });
		expect(h.names).toEqual(["Glimpse"]);
		c.update({ live: "running" });
		c.update({ live: "paused" });
		c.update({ live: "paused", private: false });
		c.update({ live: "off" });
		expect(h.names).toEqual(["Glimpse", "Glimpse — Live running", "Glimpse — Live paused", "Glimpse"]);
	});

	test("hosts without the hook still work", () => {
		const c = new TrayController({ setMenu: () => {}, setImage: () => {} }, base);
		expect(() => c.update({ live: "running" })).not.toThrow();
	});
});

describe("trayAccessibleNameSetter", () => {
	const fakeTray = (id = 1) => {
		const titles: string[] = [];
		return { titles, tray: { id, setTitle: (t: string) => titles.push(t) } };
	};
	const fakeNative = (ok = true) => {
		const calls: [number, string][] = [];
		const native: TrayLabelNative = {
			setAccessibilityLabel: (id, label) => {
				calls.push([id, label]);
				return ok;
			},
		};
		return { calls, native };
	};

	test("Windows: the Electrobun title is the tooltip Narrator reads", () => {
		const t = fakeTray();
		const n = fakeNative();
		const set = trayAccessibleNameSetter("windows", t.tray, () => n.native);
		set("Glimpse — Live running");
		expect(t.titles).toEqual(["Glimpse — Live running"]);
		expect(n.calls).toEqual([]);
		set("x".repeat(200));
		expect(t.titles[1]?.length).toBe(127);
	});

	test("macOS: the helper labels the status item, never the visible title", () => {
		const t = fakeTray(7);
		const n = fakeNative();
		trayAccessibleNameSetter("macos", t.tray, () => n.native)("Glimpse — Live paused");
		expect(n.calls).toEqual([[7, "Glimpse — Live paused"]]);
		expect(t.titles).toEqual([]);
	});

	test("macOS failures warn once and never throw", () => {
		const warnings: string[] = [];
		const t = fakeTray();
		const missing = trayAccessibleNameSetter(
			"macos",
			t.tray,
			() => null,
			(m) => warnings.push(m),
		);
		missing("Glimpse");
		missing("Glimpse — Live running");
		expect(warnings.length).toBe(1);
		const notFound = trayAccessibleNameSetter(
			"macos",
			t.tray,
			() => fakeNative(false).native,
			(m) => warnings.push(m),
		);
		notFound("Glimpse");
		expect(warnings[1]).toContain("status item not found");
		const noTray = trayAccessibleNameSetter(
			"macos",
			fakeTray(0).tray,
			() => fakeNative().native,
			(m) => warnings.push(m),
		);
		expect(() => noTray("Glimpse")).not.toThrow();
		expect(warnings[2]).toContain("no tray");
	});

	test("Linux (dev): nothing", () => {
		const t = fakeTray();
		const n = fakeNative();
		trayAccessibleNameSetter("linux", t.tray, () => n.native)("Glimpse");
		expect(t.titles).toEqual([]);
		expect(n.calls).toEqual([]);
	});
});
