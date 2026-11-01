// Pure, platform-independent hotkey logic for the GLIM-14 spike.
// No Electrobun or FFI imports here, so it is unit-testable on any OS (`bun test`).

export type Platform = "win32" | "darwin" | "linux";
export type ActionId = "snip" | "live";
export type Modifier = "ctrl" | "alt" | "shift" | "cmd";

export interface Chord {
	mods: Set<Modifier>;
	/** Lower-case key name: "a".."z", "0".."9", "f1".."f24", "space", ... */
	key: string;
}

export interface HotkeyDef {
	action: ActionId;
	label: string;
	/** Electron-style accelerator, the format Electrobun's GlobalShortcut takes. */
	accelerator: string;
}

/** GLIM-23 accepted defaults. */
export function defaultHotkeys(platform: Platform): HotkeyDef[] {
	if (platform === "darwin") {
		return [
			{ action: "snip", label: "Snip", accelerator: "Control+Shift+S" },
			{ action: "live", label: "Live toggle", accelerator: "Control+Shift+L" },
		];
	}
	// Windows (Linux uses the same chords for local smoke runs only).
	return [
		{ action: "snip", label: "Snip", accelerator: "Alt+Shift+S" },
		{ action: "live", label: "Live toggle", accelerator: "Alt+Shift+L" },
	];
}

const MOD_ALIASES: Record<string, Modifier> = {
	ctrl: "ctrl",
	control: "ctrl",
	alt: "alt",
	option: "alt",
	opt: "alt",
	shift: "shift",
	cmd: "cmd",
	command: "cmd",
	meta: "cmd",
	super: "cmd",
};

/**
 * Parse "Control+Shift+S" style accelerators. "CommandOrControl" is rejected on
 * purpose: GLIM-23 picks modifiers per OS, so the spike never wants the
 * Ctrl<->Cmd mapping.
 */
export function parseAccelerator(accel: string): Chord {
	const parts = accel
		.split("+")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	if (parts.length === 0) throw new Error(`Empty accelerator: "${accel}"`);
	const mods = new Set<Modifier>();
	const keyPart = parts[parts.length - 1]!;
	for (const raw of parts.slice(0, -1)) {
		const m = MOD_ALIASES[raw.toLowerCase()];
		if (!m) throw new Error(`Unknown modifier "${raw}" in "${accel}"`);
		if (mods.has(m)) throw new Error(`Duplicate modifier "${raw}" in "${accel}"`);
		mods.add(m);
	}
	const key = keyPart.toLowerCase();
	if (MOD_ALIASES[key]) throw new Error(`Accelerator "${accel}" has no non-modifier key`);
	if (!isKnownKey(key)) throw new Error(`Unknown key "${keyPart}" in "${accel}"`);
	return { mods, key };
}

function isKnownKey(key: string): boolean {
	if (/^[a-z0-9]$/.test(key)) return true;
	if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return true;
	return ["space", "tab", "escape", "esc", "return", "enter"].includes(key);
}

/** Canonical Electrobun accelerator string (stable mod order). */
export function toElectrobunAccelerator(chord: Chord): string {
	const order: [Modifier, string][] = [
		["cmd", "Command"],
		["ctrl", "Control"],
		["alt", "Alt"],
		["shift", "Shift"],
	];
	const mods = order.filter(([m]) => chord.mods.has(m)).map(([, name]) => name);
	const key = chord.key.length === 1 ? chord.key.toUpperCase() : chord.key[0]!.toUpperCase() + chord.key.slice(1);
	return [...mods, key].join("+");
}

/** Human-facing label using OS-native glyphs on macOS (GLIM-23). */
export function displayChord(chord: Chord, platform: Platform): string {
	const key = chord.key.toUpperCase();
	if (platform === "darwin") {
		// Apple's canonical order: Control, Option, Shift, Command.
		const glyphs: [Modifier, string][] = [
			["ctrl", "⌃"],
			["alt", "⌥"],
			["shift", "⇧"],
			["cmd", "⌘"],
		];
		return glyphs.filter(([m]) => chord.mods.has(m)).map(([, g]) => g).join("") + key;
	}
	const names: [Modifier, string][] = [
		["ctrl", "Ctrl"],
		["alt", "Alt"],
		["shift", "Shift"],
		["cmd", "Win"],
	];
	return [...names.filter(([m]) => chord.mods.has(m)).map(([, n]) => n), key].join("+");
}

// ---- Carbon (macOS) ----------------------------------------------------------

/** Carbon modifier bits from <HIToolbox/Events.h>. */
export const CARBON_MODS = {
	cmd: 0x0100, // cmdKey
	shift: 0x0200, // shiftKey
	alt: 0x0800, // optionKey
	ctrl: 0x1000, // controlKey
} as const;

/** kVK_ANSI_* virtual key codes (physical position, US ANSI layout names). */
const KVK: Record<string, number> = {
	a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07,
	c: 0x08, v: 0x09, b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f, y: 0x10,
	t: 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17,
	"9": 0x19, "7": 0x1a, "8": 0x1c, "0": 0x1d, o: 0x1f, u: 0x20, i: 0x22,
	p: 0x23, l: 0x25, j: 0x26, k: 0x28, n: 0x2d, m: 0x2e,
	return: 0x24, enter: 0x24, tab: 0x30, space: 0x31, escape: 0x35, esc: 0x35,
	f1: 0x7a, f2: 0x78, f3: 0x63, f4: 0x76, f5: 0x60, f6: 0x61, f7: 0x62, f8: 0x64,
	f9: 0x65, f10: 0x6d, f11: 0x67, f12: 0x6f, f13: 0x69, f14: 0x6b, f15: 0x71,
	f16: 0x6a, f17: 0x40, f18: 0x4f, f19: 0x50, f20: 0x5a,
};

export function toCarbon(chord: Chord): { keyCode: number; mods: number } {
	const keyCode = KVK[chord.key];
	if (keyCode === undefined) throw new Error(`No Carbon key code for "${chord.key}"`);
	let mods = 0;
	for (const m of chord.mods) mods |= CARBON_MODS[m];
	return { keyCode, mods };
}

/** OSStatus values the Carbon backend can return. */
export function describeOSStatus(status: number): string {
	switch (status) {
		case 0:
			return "noErr (registered)";
		case -9878:
			return "eventHotKeyExistsErr: another app holds this hot key (exclusive)";
		case -9879:
			return "eventHotKeyInvalidErr: hot key rejected by the system (reserved or invalid modifiers)";
		case -50:
			return "paramErr: bad argument";
		case -9850:
			return "eventAlreadyPostedErr";
		default:
			return `OSStatus ${status}`;
	}
}

// ---- Windows --------------------------------------------------------------

/** Win32 errors seen in Electrobun's log line "Failed to register hotkey ... Win32 error: N". */
export function describeWin32Error(code: number): string {
	switch (code) {
		case 1409:
			return "ERROR_HOTKEY_ALREADY_REGISTERED: another app holds this hot key";
		case 1419:
			return "ERROR_HOTKEY_NOT_REGISTERED";
		case 87:
			return "ERROR_INVALID_PARAMETER";
		default:
			return `Win32 error ${code}`;
	}
}

// ---- press log ---------------------------------------------------------------

export interface PressEvent {
	action: ActionId;
	backend: string;
	/** ms since epoch */
	at: number;
	/** ms since the previous press of the same action, or null for the first. */
	sincePrev: number | null;
	/** Heuristic: presses < 120 ms apart are almost certainly key auto-repeat. */
	likelyRepeat: boolean;
}

export const REPEAT_THRESHOLD_MS = 120;

export class PressLog {
	readonly counts: Record<ActionId, number> = { snip: 0, live: 0 };
	readonly events: PressEvent[] = [];
	private last: Partial<Record<ActionId, number>> = {};
	/** Live is a toggle (GLIM-23); track the state the real app would be in. */
	livePinned = false;

	constructor(private readonly maxEvents = 200) {}

	record(action: ActionId, backend: string, at: number): PressEvent {
		const prev = this.last[action];
		const sincePrev = prev === undefined ? null : at - prev;
		const ev: PressEvent = {
			action,
			backend,
			at,
			sincePrev,
			likelyRepeat: sincePrev !== null && sincePrev < REPEAT_THRESHOLD_MS,
		};
		this.last[action] = at;
		this.counts[action]++;
		if (action === "live") this.livePinned = !this.livePinned;
		this.events.push(ev);
		if (this.events.length > this.maxEvents) this.events.shift();
		return ev;
	}

	reset(): void {
		this.counts.snip = 0;
		this.counts.live = 0;
		this.events.length = 0;
		this.last = {};
		this.livePinned = false;
	}
}

/** Local wall-clock timestamp with milliseconds, e.g. "14:03:07.512". */
export function formatTime(ms: number): string {
	const d = new Date(ms);
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function formatPressLine(ev: PressEvent): string {
	const parts = [
		`[${formatTime(ev.at)}]`,
		`${ev.action.toUpperCase()}`,
		`backend=${ev.backend}`,
		ev.sincePrev === null ? "first" : `+${ev.sincePrev}ms`,
	];
	if (ev.likelyRepeat) parts.push("LIKELY-AUTOREPEAT");
	return parts.join(" ");
}

export type BackendName = "electrobun" | "carbon";

/**
 * Which backend to start with. Default is Electrobun's built-in (variant A) so a
 * plain launch tests that; GLIM_HOTKEY_BACKEND=carbon or the tray menu picks B.
 */
export function pickBackend(platform: Platform, envValue: string | undefined): BackendName {
	const v = envValue?.trim().toLowerCase();
	if (!v || v === "electrobun") return "electrobun";
	if (v === "carbon") {
		if (platform !== "darwin") throw new Error("GLIM_HOTKEY_BACKEND=carbon is macOS-only");
		return "carbon";
	}
	throw new Error(`Unknown GLIM_HOTKEY_BACKEND "${envValue}" (use electrobun or carbon)`);
}
