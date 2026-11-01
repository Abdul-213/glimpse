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
		},
	};
}
