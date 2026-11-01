import { describe, expect, test } from "bun:test";
import {
	fromStoredHotkey,
	type Hotkey,
	hotkeyKeys,
	hotkeyLabel,
	hotkeySpoken,
	keyFromCode,
	recordStep,
	toStoredHotkey,
	validateHotkey,
} from "../src/hotkey.ts";

const key = (code: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) => ({
	code,
	ctrlKey: mods.ctrl ?? false,
	altKey: mods.alt ?? false,
	shiftKey: mods.shift ?? false,
	metaKey: mods.meta ?? false,
});
const hk = (k: string, mods: Partial<Omit<Hotkey, "key">> = {}): Hotkey => ({
	ctrl: false,
	alt: false,
	shift: false,
	meta: false,
	...mods,
	key: k,
});

describe("recording", () => {
	test("physical keys, not layout characters", () => {
		expect(keyFromCode("KeyS")).toBe("S");
		expect(keyFromCode("Digit5")).toBe("5");
		expect(keyFromCode("F12")).toBe("F12");
		expect(keyFromCode("F25")).toBeNull();
		expect(keyFromCode("Numpad5")).toBeNull();
		expect(keyFromCode("Slash")).toBe("Slash");
	});

	test("steps", () => {
		expect(recordStep(key("ShiftLeft", { shift: true, alt: true }))).toEqual({
			kind: "modifiers",
			preview: { ctrl: false, alt: true, shift: true, meta: false },
		});
		expect(recordStep(key("Escape"))).toEqual({ kind: "cancel" });
		expect(recordStep(key("Backspace"))).toEqual({ kind: "clear" });
		expect(recordStep(key("Tab"))).toEqual({ kind: "ignore" });
		expect(recordStep(key("Tab", { shift: true }))).toEqual({ kind: "ignore" });
		expect(recordStep(key("KeyS", { alt: true, shift: true }))).toEqual({
			kind: "hotkey",
			hotkey: hk("S", { alt: true, shift: true }),
		});
		// Esc with a modifier is a combo, not a cancel (and validation decides).
		expect(recordStep(key("Escape", { ctrl: true })).kind).toBe("ignore");
	});
});

describe("formatting", () => {
	const snipWin = hk("S", { alt: true, shift: true });
	const snipMac = hk("S", { ctrl: true, shift: true });

	test("OS-native key caps and labels (GLIM-23 defaults)", () => {
		expect(hotkeyKeys(snipWin, "windows")).toEqual(["Alt", "Shift", "S"]);
		expect(hotkeyLabel(snipWin, "windows")).toBe("Alt+Shift+S");
		expect(hotkeyKeys(snipMac, "macos")).toEqual(["⌃", "⇧", "S"]);
		expect(hotkeyLabel(snipMac, "macos")).toBe("⌃⇧S");
		expect(hotkeyLabel(hk("ArrowUp", { meta: true, alt: true, ctrl: true, shift: true }), "macos")).toBe("⌃⌥⇧⌘↑");
		expect(hotkeyLabel(hk("Slash", { ctrl: true }), "windows")).toBe("Ctrl+/");
	});

	test("spoken and accelerator forms", () => {
		expect(hotkeySpoken(snipMac, "macos")).toBe("Control Shift S");
		expect(hotkeySpoken(hk("L", { meta: true, alt: true }), "macos")).toBe("Option Command L");
		// Matches @glimpse/core's stored form (canonicalHotkey) and round-trips.
		expect(toStoredHotkey(snipWin)).toBe("Alt+Shift+S");
		expect(toStoredHotkey(hk("S", { meta: true, ctrl: true }))).toBe("Ctrl+Meta+S");
		expect(toStoredHotkey(hk("Slash", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+Slash");
		expect(fromStoredHotkey("Ctrl+Shift+S")).toEqual(snipMac);
		expect(fromStoredHotkey(toStoredHotkey(hk("F5", { alt: true })))).toEqual(hk("F5", { alt: true }));
		expect(fromStoredHotkey(null)).toBeNull();
		expect(fromStoredHotkey("Alt+Banana")).toBeNull();
	});
});

describe("validation (GLIM-23)", () => {
	test("defaults and pre-vetted alternatives pass", () => {
		expect(validateHotkey(hk("S", { alt: true, shift: true }), "windows").level).toBe("ok");
		expect(validateHotkey(hk("L", { alt: true, shift: true }), "windows").level).toBe("ok");
		expect(validateHotkey(hk("Y", { alt: true, shift: true }), "windows").level).toBe("ok");
		expect(validateHotkey(hk("S", { ctrl: true, shift: true }), "macos").level).toBe("ok");
		expect(validateHotkey(hk("S", { ctrl: true, meta: true }), "macos").level).toBe("ok");
	});

	test("blocked", () => {
		expect(validateHotkey(hk("S"), "windows").level).toBe("blocked");
		expect(validateHotkey(hk("S", { shift: true }), "macos").level).toBe("blocked");
		expect(validateHotkey(hk("F12", { ctrl: true }), "windows").level).toBe("blocked");
		expect(validateHotkey(hk("S", { alt: true }), "macos").level).toBe("blocked");
		expect(validateHotkey(hk("S", { alt: true, shift: true }), "macos").level).toBe("blocked");
		expect(validateHotkey(hk("ArrowUp", { ctrl: true }), "windows").level).toBe("blocked");
		expect(validateHotkey(hk("Enter", { meta: true }), "macos").level).toBe("blocked");
	});

	test("warned", () => {
		expect(validateHotkey(hk("S", { meta: true, shift: true }), "windows").level).toBe("warning");
		expect(validateHotkey(hk("P", { ctrl: true, alt: true }), "windows").level).toBe("warning");
		expect(validateHotkey(hk("W", { alt: true, shift: true }), "windows").level).toBe("warning");
		expect(validateHotkey(hk("F12", { ctrl: true }), "macos").level).toBe("ok");
	});
});
