// Global hotkey bindings as stored in settings, and the GLIM-23 defaults.
//
// Stored as a canonical accelerator string, `Alt+Shift+S`: readable in the file, easy to
// compare. Modifier order is fixed (Ctrl, Alt, Shift, Meta). `Meta` is ⌘ on macOS and the
// Windows key on Windows. The hotkeys service (GLIM-23 impl) maps this to Electrobun
// GlobalShortcut accelerators on Windows and Carbon key codes on macOS; the UI shows OS
// glyphs (⌃⇧S).

import { map, nullable, object, refine, type Schema, string, withDefault } from "../schema/index.ts";

export type Modifier = "Ctrl" | "Alt" | "Shift" | "Meta";
const MODIFIERS: readonly Modifier[] = ["Ctrl", "Alt", "Shift", "Meta"];

export interface HotkeyParts {
	readonly modifiers: readonly Modifier[];
	readonly key: string;
}

/** A canonical accelerator such as `Alt+Shift+S`. Build with `parseHotkey`/`formatHotkey`. */
export type Hotkey = string;

const NAMED_KEYS = [
	"Space",
	"Minus",
	"Equal",
	"Comma",
	"Period",
	"Slash",
	"Semicolon",
	"Quote",
	"BracketLeft",
	"BracketRight",
	"Backslash",
	"Backquote",
	"Insert",
	"Delete",
	"Home",
	"End",
	"PageUp",
	"PageDown",
] as const;

/** Keys that must never be global (GLIM-23: Esc, Enter, arrows belong to Glimpse surfaces). */
const NEVER_GLOBAL = new Set(["Escape", "Esc", "Enter", "Return", "Tab", "Backspace", "Up", "Down", "Left", "Right"]);

const isFunctionKey = (key: string) => /^F([1-9]|1[0-9]|2[0-4])$/.test(key);

function canonicalKey(raw: string): string | null {
	const key = raw.length === 1 ? raw.toUpperCase() : raw;
	if (/^[A-Z0-9]$/.test(key) || isFunctionKey(key)) return key;
	const named = NAMED_KEYS.find((k) => k.toLowerCase() === key.toLowerCase());
	return named ?? null;
}

function canonicalModifier(raw: string): Modifier | null {
	switch (raw.toLowerCase()) {
		case "ctrl":
		case "control":
			return "Ctrl";
		case "alt":
		case "option":
			return "Alt";
		case "shift":
			return "Shift";
		case "meta":
		case "cmd":
		case "command":
		case "super":
		case "win":
			return "Meta";
		default:
			return null;
	}
}

/** Why a combo can't be a global hotkey, or null if it can. */
export function hotkeyProblem(input: string): string | null {
	const parts = input.split("+").map((p) => p.trim());
	const rawKey = parts.pop() ?? "";
	if (NEVER_GLOBAL.has(rawKey) || /^Arrow/.test(rawKey)) return `${rawKey} can't be a global hotkey`;
	const key = canonicalKey(rawKey);
	if (!key) return `unknown key ${JSON.stringify(rawKey)}`;
	const mods = new Set<Modifier>();
	for (const p of parts) {
		const m = canonicalModifier(p);
		if (!m) return `unknown modifier ${JSON.stringify(p)}`;
		if (mods.has(m)) return `${m} appears twice`;
		mods.add(m);
	}
	const nonShift = [...mods].some((m) => m !== "Shift");
	if (!isFunctionKey(key) && !nonShift) return "needs Ctrl, Alt or Meta (Shift alone types characters)";
	return null;
}

export function parseHotkey(input: string): HotkeyParts | null {
	if (hotkeyProblem(input) !== null) return null;
	const parts = input.split("+").map((p) => p.trim());
	const key = canonicalKey(parts.pop() ?? "");
	if (!key) return null;
	const set = new Set(parts.map(canonicalModifier));
	return { modifiers: MODIFIERS.filter((m) => set.has(m)), key };
}

export const formatHotkey = (parts: HotkeyParts): Hotkey =>
	[...MODIFIERS.filter((m) => parts.modifiers.includes(m)), parts.key].join("+");

/** Canonicalise (`shift+alt+s` -> `Alt+Shift+S`), or null if not a valid global hotkey. */
export function canonicalHotkey(input: string): Hotkey | null {
	const parts = parseHotkey(input);
	return parts ? formatHotkey(parts) : null;
}

export const hotkeySchema = (): Schema<Hotkey> =>
	map(
		refine(string({ maxLength: 64 }), (s) => hotkeyProblem(s)),
		(s) => canonicalHotkey(s) ?? s,
	);

/** Global actions. Only Snip and Live are bound by default (GLIM-23); the Live extras are optional (GLIM-130). */
export interface HotkeyBindings {
	readonly snip: Hotkey | null;
	readonly live: Hotkey | null;
	readonly pauseLive: Hotkey | null;
	readonly resnip: Hotkey | null;
	readonly toggleLivePopup: Hotkey | null;
	/** GLIM-130: move keyboard focus to the Live popup (keyboard and screen-reader users). */
	readonly focusLivePopup: Hotkey | null;
}

export type HotkeyAction = keyof HotkeyBindings;

/** GLIM-23 defaults. Same letters on both OSes, least-conflicting modifiers per OS. */
export const DEFAULT_HOTKEYS: { readonly windows: HotkeyBindings; readonly macos: HotkeyBindings } = {
	windows: {
		snip: "Alt+Shift+S",
		live: "Alt+Shift+L",
		pauseLive: null,
		resnip: null,
		toggleLivePopup: null,
		focusLivePopup: null,
	},
	macos: {
		snip: "Ctrl+Shift+S",
		live: "Ctrl+Shift+L",
		pauseLive: null,
		resnip: null,
		toggleLivePopup: null,
		focusLivePopup: null,
	},
};

/**
 * Bindings with per-action defaults. `null` in the file means "unbound on purpose" and is
 * kept; an invalid combo resets that action to its default. A combo bound to two actions
 * keeps the first (in field order) and unbinds the later one.
 */
export function hotkeyBindingsSchema(defaults: HotkeyBindings): Schema<HotkeyBindings> {
	const base = object({
		snip: withDefault(nullable(hotkeySchema()), defaults.snip),
		live: withDefault(nullable(hotkeySchema()), defaults.live),
		pauseLive: withDefault(nullable(hotkeySchema()), defaults.pauseLive),
		resnip: withDefault(nullable(hotkeySchema()), defaults.resnip),
		toggleLivePopup: withDefault(nullable(hotkeySchema()), defaults.toggleLivePopup),
		focusLivePopup: withDefault(nullable(hotkeySchema()), defaults.focusLivePopup),
	});
	return {
		parse(input, ctx) {
			const r = base.parse(input, ctx);
			if (!r.ok) return r;
			const out: Record<string, Hotkey | null> = { ...r.value };
			const seen = new Map<Hotkey, string>();
			for (const [action, combo] of Object.entries(r.value)) {
				if (combo === null) continue;
				const owner = seen.get(combo);
				if (owner) {
					ctx.issues.push({
						path: ctx.path ? `${ctx.path}.${action}` : action,
						message: `${combo} is already bound to ${owner}; unbound`,
					});
					out[action] = null;
				} else seen.set(combo, action);
			}
			return { ok: true, value: out as unknown as HotkeyBindings };
		},
	};
}
