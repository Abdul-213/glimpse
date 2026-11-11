import { describe, expect, test } from "bun:test";
import {
	CARBON_MODS,
	PressLog,
	REPEAT_THRESHOLD_MS,
	defaultHotkeys,
	describeOSStatus,
	describeWin32Error,
	displayChord,
	formatPressLine,
	formatTime,
	parseAccelerator,
	pickBackend,
	toCarbon,
	toElectrobunAccelerator,
} from "../src/shared/hotkeys";

describe("GLIM-23 defaults", () => {
	test("Windows uses Alt+Shift+S / Alt+Shift+L", () => {
		expect(defaultHotkeys("win32").map((h) => h.accelerator)).toEqual(["Alt+Shift+S", "Alt+Shift+L"]);
	});
	test("macOS uses Control+Shift+S / Control+Shift+L (not Cmd)", () => {
		expect(defaultHotkeys("darwin").map((h) => h.accelerator)).toEqual([
			"Control+Shift+S",
			"Control+Shift+L",
		]);
	});
	test("defaults display with OS conventions", () => {
		const [snipMac, liveMac] = defaultHotkeys("darwin").map((h) => displayChord(parseAccelerator(h.accelerator), "darwin"));
		expect(snipMac).toBe("⌃⇧S");
		expect(liveMac).toBe("⌃⇧L");
		const [snipWin] = defaultHotkeys("win32").map((h) => displayChord(parseAccelerator(h.accelerator), "win32"));
		expect(snipWin).toBe("Alt+Shift+S");
	});
});

describe("parseAccelerator", () => {
	test("aliases and case", () => {
		const c = parseAccelerator("ctrl+SHIFT+s");
		expect([...c.mods].sort()).toEqual(["ctrl", "shift"]);
		expect(c.key).toBe("s");
		expect([...parseAccelerator("Option+Cmd+F9").mods].sort()).toEqual(["alt", "cmd"]);
	});
	test("rejects CommandOrControl (GLIM-23 picks modifiers per OS)", () => {
		expect(() => parseAccelerator("CommandOrControl+Shift+S")).toThrow(/Unknown modifier/);
	});
	test("rejects junk", () => {
		expect(() => parseAccelerator("")).toThrow();
		expect(() => parseAccelerator("Shift")).toThrow(/no non-modifier key/);
		expect(() => parseAccelerator("Shift+Shift+S")).toThrow(/Duplicate/);
		expect(() => parseAccelerator("Alt+Shift+Ś")).toThrow(/Unknown key/);
		expect(() => parseAccelerator("Alt+F25")).toThrow(/Unknown key/);
	});
	test("round-trips to Electrobun's accelerator format", () => {
		expect(toElectrobunAccelerator(parseAccelerator("shift+alt+s"))).toBe("Alt+Shift+S");
		expect(toElectrobunAccelerator(parseAccelerator("shift+control+l"))).toBe("Control+Shift+L");
		expect(toElectrobunAccelerator(parseAccelerator("ctrl+alt+f9"))).toBe("Control+Alt+F9");
	});
});

describe("Carbon mapping", () => {
	test("⌃⇧S -> kVK_ANSI_S (0x01), controlKey|shiftKey", () => {
		expect(toCarbon(parseAccelerator("Control+Shift+S"))).toEqual({
			keyCode: 0x01,
			mods: CARBON_MODS.ctrl | CARBON_MODS.shift,
		});
		expect(CARBON_MODS.ctrl | CARBON_MODS.shift).toBe(0x1200);
	});
	test("⌃⇧L -> kVK_ANSI_L (0x25)", () => {
		expect(toCarbon(parseAccelerator("Control+Shift+L")).keyCode).toBe(0x25);
	});
	test("fallback ⌃⌘S / F-keys map", () => {
		expect(toCarbon(parseAccelerator("Control+Command+S")).mods).toBe(0x1100);
		expect(toCarbon(parseAccelerator("Control+Alt+F9")).keyCode).toBe(0x65);
	});
	test("status descriptions", () => {
		expect(describeOSStatus(0)).toMatch(/noErr/);
		expect(describeOSStatus(-9878)).toMatch(/eventHotKeyExistsErr/);
		expect(describeOSStatus(-9879)).toMatch(/eventHotKeyInvalidErr/);
		expect(describeOSStatus(-1)).toBe("OSStatus -1");
		expect(describeWin32Error(1409)).toMatch(/ALREADY_REGISTERED/);
	});
});

describe("PressLog", () => {
	test("counts, intervals, auto-repeat heuristic, live toggle", () => {
		const log = new PressLog();
		const a = log.record("snip", "carbon", 1_000);
		expect(a.sincePrev).toBeNull();
		expect(a.likelyRepeat).toBe(false);
		const b = log.record("snip", "carbon", 1_000 + REPEAT_THRESHOLD_MS - 1);
		expect(b.likelyRepeat).toBe(true);
		const c = log.record("snip", "carbon", 5_000);
		expect(c.likelyRepeat).toBe(false);
		expect(log.counts).toEqual({ snip: 3, live: 0 });
		log.record("live", "carbon", 6_000);
		expect(log.livePinned).toBe(true);
		log.record("live", "carbon", 7_000);
		expect(log.livePinned).toBe(false);
		log.reset();
		expect(log.counts).toEqual({ snip: 0, live: 0 });
		expect(log.events).toHaveLength(0);
	});
	test("bounded history", () => {
		const log = new PressLog(3);
		for (let i = 0; i < 10; i++) log.record("live", "electrobun", i * 1000);
		expect(log.events).toHaveLength(3);
		expect(log.counts.live).toBe(10);
	});
	test("formatting", () => {
		expect(formatTime(new Date(2026, 0, 1, 9, 5, 7, 42).getTime())).toBe("09:05:07.042");
		const log = new PressLog();
		log.record("snip", "electrobun", 0);
		const line = formatPressLine(log.record("snip", "electrobun", 50));
		expect(line).toMatch(/SNIP backend=electrobun \+50ms LIKELY-AUTOREPEAT$/);
	});
});

describe("pickBackend", () => {
	test("defaults to Electrobun's built-in", () => {
		expect(pickBackend("darwin", undefined)).toBe("electrobun");
		expect(pickBackend("win32", "")).toBe("electrobun");
	});
	test("carbon only on macOS", () => {
		expect(pickBackend("darwin", "Carbon")).toBe("carbon");
		expect(() => pickBackend("win32", "carbon")).toThrow(/macOS-only/);
		expect(() => pickBackend("darwin", "nsevent")).toThrow(/Unknown/);
	});
});
