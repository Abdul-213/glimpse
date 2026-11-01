// Hotkey recorder logic (GLIM-23 decision, "Validate user-chosen combos"). Pure: works on
// a KeyboardEvent-shaped object so it can be tested without a DOM. Keys are taken from
// `event.code` (the physical key), so a recorded hotkey doesn't change with the layout.
import type { Hotkey as StoredHotkey } from "@glimpse/core";
import type { UiPlatform } from "./platform.ts";

export interface Hotkey {
	readonly ctrl: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
	/** ⌘ on macOS, the Windows key on Windows. */
	readonly meta: boolean;
	/** Physical key name: "S", "5", "F5", "Space", "ArrowUp", "Minus", ... */
	readonly key: string;
}

export interface KeyLike {
	readonly code: string;
	readonly ctrlKey: boolean;
	readonly altKey: boolean;
	readonly shiftKey: boolean;
	readonly metaKey: boolean;
}

export type RecordStep =
	/** Only modifiers are down: show them as a live preview. */
	| { readonly kind: "modifiers"; readonly preview: Omit<Hotkey, "key"> }
	| { readonly kind: "hotkey"; readonly hotkey: Hotkey }
	/** Esc with no modifiers: stop recording, keep the old value. */
	| { readonly kind: "cancel" }
	/** Backspace or Delete with no modifiers: clear (unbind). */
	| { readonly kind: "clear" }
	/** Tab and keys we can't bind: let the browser handle them. */
	| { readonly kind: "ignore" };

const MODIFIER_CODES = new Set([
	"ControlLeft",
	"ControlRight",
	"AltLeft",
	"AltRight",
	"ShiftLeft",
	"ShiftRight",
	"MetaLeft",
	"MetaRight",
	"OSLeft",
	"OSRight",
	"CapsLock",
	"Fn",
]);

const NAMED_KEYS = new Set([
	"Space",
	"Enter",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
	"Insert",
	"Delete",
	"Backspace",
	"Minus",
	"Equal",
	"BracketLeft",
	"BracketRight",
	"Backslash",
	"Semicolon",
	"Quote",
	"Comma",
	"Period",
	"Slash",
	"Backquote",
]);

/** `KeyS` -> `S`, `Digit5` -> `5`, `F5` -> `F5`, `Numpad5` -> null (not bindable here). */
export function keyFromCode(code: string): string | null {
	const letter = /^Key([A-Z])$/.exec(code);
	if (letter?.[1]) return letter[1];
	const digit = /^Digit([0-9])$/.exec(code);
	if (digit?.[1]) return digit[1];
	if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
	return NAMED_KEYS.has(code) ? code : null;
}

/** Interpret one keydown while the recorder is listening. */
export function recordStep(e: KeyLike): RecordStep {
	const mods = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
	const anyMod = mods.ctrl || mods.alt || mods.shift || mods.meta;
	if (MODIFIER_CODES.has(e.code)) return { kind: "modifiers", preview: mods };
	if (!anyMod && e.code === "Escape") return { kind: "cancel" };
	if (!anyMod && (e.code === "Backspace" || e.code === "Delete")) return { kind: "clear" };
	if (e.code === "Tab") return { kind: "ignore" };
	const key = keyFromCode(e.code);
	if (!key) return { kind: "ignore" };
	return { kind: "hotkey", hotkey: { ...mods, key } };
}

const MAC_GLYPHS: Record<string, string> = {
	ArrowUp: "↑",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
	Enter: "↩",
	Backspace: "⌫",
	Delete: "⌦",
	PageUp: "⇞",
	PageDown: "⇟",
	Home: "↖",
	End: "↘",
};
const PUNCTUATION: Record<string, string> = {
	Minus: "-",
	Equal: "=",
	BracketLeft: "[",
	BracketRight: "]",
	Backslash: "\\",
	Semicolon: ";",
	Quote: "'",
	Comma: ",",
	Period: ".",
	Slash: "/",
	Backquote: "`",
};
const WIN_NAMES: Record<string, string> = {
	ArrowUp: "Up",
	ArrowDown: "Down",
	ArrowLeft: "Left",
	ArrowRight: "Right",
	PageUp: "Page Up",
	PageDown: "Page Down",
	Delete: "Del",
	Insert: "Ins",
};

function keyLabel(key: string, platform: UiPlatform): string {
	if (PUNCTUATION[key]) return PUNCTUATION[key];
	if (platform === "macos") return MAC_GLYPHS[key] ?? key;
	return WIN_NAMES[key] ?? key;
}

/**
 * Keys as the OS shows them, one entry per key cap (DESIGN.md kbd chips).
 * macOS order ⌃ ⌥ ⇧ ⌘; Windows Ctrl, Alt, Shift, Win.
 */
export function hotkeyKeys(h: Partial<Hotkey>, platform: UiPlatform): string[] {
	const out: string[] = [];
	if (platform === "macos") {
		if (h.ctrl) out.push("⌃");
		if (h.alt) out.push("⌥");
		if (h.shift) out.push("⇧");
		if (h.meta) out.push("⌘");
	} else {
		if (h.ctrl) out.push("Ctrl");
		if (h.alt) out.push("Alt");
		if (h.shift) out.push("Shift");
		if (h.meta) out.push("Win");
	}
	if (h.key) out.push(keyLabel(h.key, platform));
	return out;
}

/** One-line label: "⌃⇧S" on macOS, "Alt+Shift+S" on Windows. */
export function hotkeyLabel(h: Hotkey, platform: UiPlatform): string {
	return hotkeyKeys(h, platform).join(platform === "macos" ? "" : "+");
}

/** Spoken label for aria: "Control Shift S" / "Alt Shift S". */
export function hotkeySpoken(h: Hotkey, platform: UiPlatform): string {
	const names: string[] = [];
	if (h.ctrl) names.push("Control");
	if (h.alt) names.push(platform === "macos" ? "Option" : "Alt");
	if (h.shift) names.push("Shift");
	if (h.meta) names.push(platform === "macos" ? "Command" : "Windows");
	names.push(h.key);
	return names.join(" ");
}

/**
 * The settings form of a hotkey (`@glimpse/core` settings/hotkeys.ts): `Alt+Shift+S`, with
 * modifiers in the order Ctrl, Alt, Shift, Meta. The app process canonicalises and
 * registers it; this side only has to produce the same string.
 */
export function toStoredHotkey(h: Hotkey): StoredHotkey {
	const parts: string[] = [];
	if (h.ctrl) parts.push("Ctrl");
	if (h.alt) parts.push("Alt");
	if (h.shift) parts.push("Shift");
	if (h.meta) parts.push("Meta");
	parts.push(h.key);
	return parts.join("+");
}

/** Parse the settings form back for display. Null for anything the recorder can't show. */
export function fromStoredHotkey(stored: StoredHotkey | null | undefined): Hotkey | null {
	if (!stored) return null;
	const parts = stored.split("+").map((p) => p.trim());
	const key = parts.pop() ?? "";
	if (!/^[A-Z0-9]$/.test(key) && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key) && !NAMED_KEYS.has(key)) return null;
	const mods = new Set(parts.map((p) => p.toLowerCase()));
	return { ctrl: mods.has("ctrl"), alt: mods.has("alt"), shift: mods.has("shift"), meta: mods.has("meta"), key };
}

export interface HotkeyVerdict {
	readonly level: "ok" | "warning" | "blocked";
	readonly message?: string;
}

// The WASD/QE cluster, minus S: GLIM-23 keeps S for Snip's mnemonic (sprinting backwards
// is rare), so the default Alt+Shift+S must not warn.
const WASD = new Set(["W", "A", "D", "Q", "E"]);

/**
 * GLIM-23 rules for a user-chosen global hotkey. Blocked combos can't be saved; warnings
 * are shown under the field but the combo is kept.
 */
export function validateHotkey(h: Hotkey, platform: UiPlatform): HotkeyVerdict {
	// Same never-global keys as core's hotkeyProblem: these belong to Glimpse's own surfaces.
	if (h.key === "Enter" || h.key === "Backspace" || h.key.startsWith("Arrow")) {
		return { level: "blocked", message: "Enter, Backspace and the arrow keys can't be global shortcuts." };
	}
	const strongMods = h.ctrl || h.alt || h.meta;
	if (!strongMods) {
		return {
			level: "blocked",
			message: "Add Ctrl, Alt or another modifier. A key on its own would stop working in other apps.",
		};
	}
	if (platform === "windows") {
		if (h.key === "F12") return { level: "blocked", message: "Windows reserves F12 for debuggers." };
		if (h.meta)
			return {
				level: "warning",
				message: "Windows reserves most Win-key shortcuts and games often turn the Win key off.",
			};
		if (h.ctrl && h.alt && /^[A-Z0-9]$/.test(h.key)) {
			return {
				level: "warning",
				message: "Ctrl+Alt is AltGr on many keyboards, so this can block typing some letters.",
			};
		}
	}
	if (platform === "macos" && h.alt && !h.ctrl && !h.meta) {
		return { level: "blocked", message: "macOS doesn't allow shortcuts that use only ⌥ or ⌥⇧." };
	}
	if (WASD.has(h.key) && (h.shift || h.alt) && !h.ctrl && !h.meta) {
		return { level: "warning", message: "Games often use this letter with Shift or Alt, so it may fire by accident." };
	}
	return { level: "ok" };
}
