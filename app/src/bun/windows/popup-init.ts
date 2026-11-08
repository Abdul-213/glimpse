// The Snip popup view's per-load info (GLIM-65). Pure (no Electrobun), so the browser
// preview and tests can build it too.
import type { SnipViewInit } from "../../shared/popup-rpc.ts";

/** What the popup view gets once per load: platform, UI language and the shortcut labels (§11). */
export function snipViewInit(os: SnipViewInit["os"], uiLang = "en"): SnipViewInit {
	const mac = os === "macos";
	return {
		os,
		uiLang,
		uiDir: "ltr",
		keys: {
			copy: mac ? "⌘C" : "Ctrl+C",
			copyOriginal: mac ? "⌘⇧C" : "Ctrl+Shift+C",
			original: mac ? "⌘⇧O" : "Ctrl+Shift+O",
			close: "Esc",
			overlay: mac ? "⌘⇧T" : "Ctrl+Shift+T",
			peek: mac ? "⇧" : "Shift",
		},
	};
}

/**
 * Electrobun 2.0.6-beta.2 on macOS flips Y for `setFrame` / `setPosition` / `getFrame`
 * against the window's *current* screen height instead of the primary screen's
 * (spikes/overlay/FINDINGS.md §5). The y to pass so the window lands at global `y`, or to
 * subtract from a reported y: `y + current − primary`. Zero offset on one display or
 * displays of equal height. Pure; the popup window applies it on macOS only.
 */
export function macFlipOffset(currentScreenHeight: number, primaryScreenHeight: number): number {
	return currentScreenHeight - primaryScreenHeight;
}
