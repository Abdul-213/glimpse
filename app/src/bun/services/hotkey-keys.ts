// Canonical hotkeys (`Alt+Shift+S`, core settings/hotkeys.ts) mapped to each backend's
// codes (GLIM-23, spikes/hotkeys/src/shared/hotkeys.ts). Pure: tested on Linux.
import { type Hotkey, parseHotkey } from "@glimpse/core";

/** Electrobun GlobalShortcut accelerator (Windows RegisterHotKey). */
export function toElectrobunAccelerator(hotkey: Hotkey): string | null {
	const parts = parseHotkey(hotkey);
	if (!parts) return null;
	const names: Record<string, string> = { Ctrl: "Control", Alt: "Alt", Shift: "Shift", Meta: "Super" };
	return [...parts.modifiers.map((m) => names[m] ?? m), parts.key].join("+");
}

/** Carbon modifier bits (<HIToolbox/Events.h>). */
export const CARBON_MODS = { Meta: 0x0100, Shift: 0x0200, Alt: 0x0800, Ctrl: 0x1000 } as const;

/** kVK_* virtual key codes: physical key positions, named after the US ANSI layout. */
const KVK: Record<string, number> = {
	A: 0x00,
	S: 0x01,
	D: 0x02,
	F: 0x03,
	H: 0x04,
	G: 0x05,
	Z: 0x06,
	X: 0x07,
	C: 0x08,
	V: 0x09,
	B: 0x0b,
	Q: 0x0c,
	W: 0x0d,
	E: 0x0e,
	R: 0x0f,
	Y: 0x10,
	T: 0x11,
	"1": 0x12,
	"2": 0x13,
	"3": 0x14,
	"4": 0x15,
	"6": 0x16,
	"5": 0x17,
	Equal: 0x18,
	"9": 0x19,
	"7": 0x1a,
	Minus: 0x1b,
	"8": 0x1c,
	"0": 0x1d,
	BracketRight: 0x1e,
	O: 0x1f,
	U: 0x20,
	BracketLeft: 0x21,
	I: 0x22,
	P: 0x23,
	L: 0x25,
	J: 0x26,
	Quote: 0x27,
	K: 0x28,
	Semicolon: 0x29,
	Backslash: 0x2a,
	Comma: 0x2b,
	Slash: 0x2c,
	N: 0x2d,
	M: 0x2e,
	Period: 0x2f,
	Space: 0x31,
	Backquote: 0x32,
	F1: 0x7a,
	F2: 0x78,
	F3: 0x63,
	F4: 0x76,
	F5: 0x60,
	F6: 0x61,
	F7: 0x62,
	F8: 0x64,
	F9: 0x65,
	F10: 0x6d,
	F11: 0x67,
	F12: 0x6f,
	F13: 0x69,
	F14: 0x6b,
	F15: 0x71,
	F16: 0x6a,
	F17: 0x40,
	F18: 0x4f,
	F19: 0x50,
	F20: 0x5a,
	Insert: 0x72,
	Home: 0x73,
	PageUp: 0x74,
	Delete: 0x75,
	End: 0x77,
	PageDown: 0x79,
};

/** Carbon key code + modifier mask, or null for a key Carbon can't bind. */
export function toCarbon(hotkey: Hotkey): { keyCode: number; mods: number } | null {
	const parts = parseHotkey(hotkey);
	if (!parts) return null;
	const keyCode = KVK[parts.key];
	if (keyCode === undefined) return null;
	let mods = 0;
	for (const m of parts.modifiers) mods |= CARBON_MODS[m];
	return { keyCode, mods };
}

/** OSStatus values RegisterEventHotKey returns. */
export function describeOSStatus(status: number): string {
	switch (status) {
		case 0:
			return "registered";
		case -9878:
			return "eventHotKeyExistsErr: another app holds this shortcut";
		case -9879:
			return "eventHotKeyInvalidErr: macOS rejected this shortcut";
		case -50:
			return "paramErr: bad argument";
		default:
			return `OSStatus ${status}`;
	}
}

/** UI label with OS glyphs (GLIM-23): `⌃⇧S` on macOS, `Alt+Shift+S` on Windows. */
export function hotkeyLabel(hotkey: Hotkey, os: "macos" | "windows" | "linux"): string {
	const parts = parseHotkey(hotkey);
	if (!parts) return hotkey;
	if (os === "macos") {
		const glyph: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };
		return parts.modifiers.map((m) => glyph[m]).join("") + parts.key;
	}
	return [...parts.modifiers.map((m) => (m === "Meta" ? "Win" : m)), parts.key].join("+");
}
