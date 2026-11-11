// The Live popup's keyboard map (GLIM-81, live-popup.md §6.2), pure so it is tested on Linux.
// Only while the popup has focus; Live's global keys are hotkeys (GLIM-23).

/** live-popup.md §6.2, popup focused. ↑ ↓ Home End move between blocks (BlockList). */
export type LiveKey = "escape" | "pause" | "stop" | "copy" | "copyOriginal" | "original" | "overlay" | "refresh";

export function liveKey(
	e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
	mac: boolean,
): LiveKey | null {
	if (e.key === "Escape") return "escape";
	const mod = mac ? e.metaKey : e.ctrlKey;
	if (!mod || e.altKey) return null;
	const k = e.key.toLowerCase();
	if (k === "p" && e.shiftKey) return "pause";
	if (k === "w" && !e.shiftKey) return "stop";
	if (k === "c") return e.shiftKey ? "copyOriginal" : "copy";
	if (k === "o" && e.shiftKey) return "original";
	// GLIM-154: overlay mode, as in Snip.
	if (k === "t" && e.shiftKey) return "overlay";
	// GLIM-157: Refresh (read the area now), as a browser's reload.
	if (k === "r" && !e.shiftKey) return "refresh";
	return null;
}

/** GLIM-151: Alt+arrows (Option+arrows on macOS) move the popup; Shift for larger steps. */
export interface LiveMoveKeyPress {
	readonly direction: "up" | "down" | "left" | "right";
	readonly large: boolean;
}

const ARROWS: Readonly<Record<string, LiveMoveKeyPress["direction"]>> = {
	ArrowUp: "up",
	ArrowDown: "down",
	ArrowLeft: "left",
	ArrowRight: "right",
};

export function liveMoveKey(
	e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): LiveMoveKeyPress | null {
	const direction = ARROWS[e.key];
	if (!direction || !e.altKey || e.ctrlKey || e.metaKey) return null;
	return { direction, large: e.shiftKey };
}
