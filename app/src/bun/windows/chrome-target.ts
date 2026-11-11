// Adapts an Electrobun BrowserWindow to window-chrome.ts's ChromeTarget (GLIM-116).
import type { BrowserWindow } from "electrobun/main";
import type { ChromeTarget } from "./window-chrome.ts";

export function electrobunChromeTarget(win: BrowserWindow): ChromeTarget {
	return {
		get handle() {
			return win.ptr;
		},
		runScript: (js) => win.webview.executeJavascript(js),
		onDomReady: (listener) => win.webview.on("dom-ready", () => listener()),
	};
}
