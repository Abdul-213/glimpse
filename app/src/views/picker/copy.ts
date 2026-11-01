// Picker copy (region-picker spec 11). Exact strings; key chips use each OS's own labels.
import type { HintKey, PickerMode } from "@glimpse/core";
import type { Platform } from "../../shared/rpc.ts";

export type KeyName = "Enter" | "Alt" | "Esc" | "Tab" | "Space" | "Shift";

export function keyLabel(key: KeyName, os: Platform): string {
	if (os !== "macos") return key;
	return { Enter: "Return", Alt: "⌥", Esc: "esc", Tab: "tab", Space: "space", Shift: "⇧" }[key];
}

/** One hint bar part: plain text, or a key chip followed by its action. */
export type HintPart = { readonly text: string } | { readonly key: KeyName; readonly action: string };

/**
 * The hint for a phase. `level` 0 is the long copy, 1 the short copy, 2 drops the key
 * chips (spec 4 "Hint bar position": used when the bar overflows the work area).
 */
export function hintParts(key: HintKey, mode: PickerMode, level: 0 | 1 | 2): HintPart[] {
	const live = mode === "live";
	let parts: HintPart[];
	switch (key) {
		case "tooSmall":
			return [{ text: "Too small. Drag a larger area." }];
		case "liveOneScreen":
			return [{ text: "Live areas stay on one screen" }];
		case "dragging":
			parts = [
				{ text: live ? "Release to pin" : "Release to translate" },
				{ key: "Space", action: "Move" },
				{ key: "Shift", action: "Adjust first" },
			];
			break;
		case "adjusting":
			parts = [
				{ key: "Enter", action: live ? "Pin" : "Translate" },
				{ text: "Arrows Move" },
				{ key: "Alt", action: "Arrows Resize" },
				{ key: "Esc", action: "Cancel" },
			];
			break;
		default:
			if (level >= 1) {
				parts = [{ text: "Drag to select" }, { key: "Esc", action: "Cancel" }];
			} else {
				parts = [
					{ text: live ? "Drag over the text to watch, or click a window" : "Drag to select, or click a window" },
					{ key: "Tab", action: live ? "Switch to Snip" : "Switch to Live" },
					{ key: "Esc", action: "Cancel" },
				];
			}
	}
	return level >= 2 ? parts.filter((p) => "text" in p) : parts;
}

export const MODE_LABEL: Record<PickerMode, string> = { snip: "Snip", live: "Live" };

export const a11yLabel = (mode: PickerMode) =>
	mode === "snip" ? "Select an area to translate" : "Select an area to watch";
export const A11Y_OPEN =
	"Area picker. Drag to select, or press an arrow key to draw a box with the keyboard. Escape cancels.";
export const a11yBox = (r: { x: number; y: number; width: number; height: number }) =>
	`Selection ${Math.round(r.width)} by ${Math.round(r.height)}, at ${Math.round(r.x)}, ${Math.round(r.y)}`;
export const REPLACES_LIVE = "Replaces the current Live area";
