// The Live popup's keyboard map (GLIM-81, live-popup.md §6.2), pure so it is tested on Linux.
// Only while the popup has focus; Live's global keys are hotkeys (GLIM-23).

/** live-popup.md §6.2, popup focused. ↑ ↓ Home End move between blocks (BlockList). */
export type LiveKey = "escape" | "pause" | "stop" | "copy" | "copyOriginal" | "original";

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
	return null;
}
