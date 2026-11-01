// Native window chrome for Glimpse's windows (GLIM-116 materials, GLIM-110 theme), the one
// place window controllers go for it: what material a window gets on this OS, light / dark,
// hide by cloaking, and the DOM attributes the view's CSS keys on (`data-material`,
// `data-os-version`, `data-theme`). Follows spikes/window-materials/FINDINGS.md and
// snip-popup.md §13.1:
//
//   macOS                 popup: NSVisualEffectView .popover, behind-window, active, 12 px mask,
//                         shadow on. Reduce transparency: no effect view, solid veil.
//   Windows 11 22H2+      popup: Acrylic (DWMSBT_TRANSIENTWINDOW) on a glass sheet, DWMWCP_ROUND,
//                         no DWM border; the window is created transparent. Transparency
//                         effects off: no backdrop, solid veil.
//   Windows 11 21H2 / 10  solid veil; Windows 10 popups are square (`data-os-version="10"`).
//   Settings and other    no material for now (the view paints the solid window surface),
//   "window" roles        theme only.
//
// Theme: webviews take light / dark from the OS (prefers-color-scheme), so a forced theme sets
// `data-theme` on <html> (tokens.css carries both palettes under it) and the native appearance
// (macOS NSWindow.appearance, which WKWebView follows too; Windows DWMWA_USE_IMMERSIVE_DARK_MODE
// for the backdrop tint). "system" removes both overrides.
//
// No electrobun import: windows reach it through `ChromeTarget`, and the native side through
// the WindowChromeNative port, so all of this is tested on Linux.
import type { Pointer } from "bun:ffi";
import type { Rect } from "@glimpse/core";
import {
	DWMSBT,
	DWMWCP,
	type NativeMaterial,
	NS_MATERIAL,
	type ThemeSetting,
	WIN11_22H2_BUILD,
	WIN11_BUILD,
	type WindowChromeNative,
} from "../native/chrome.ts";

export type ChromeOs = "macos" | "windows" | "linux";
/** `popup`: the Snip (and Live) popups. `window`: Settings, onboarding: theme only. */
export type WindowRole = "popup" | "window";
export type ResolvedTheme = "light" | "dark";

export interface ChromeEnv {
	readonly os: ChromeOs;
	/** Windows build number, null elsewhere or when unknown. */
	readonly windowsBuild: number | null;
	readonly reduceTransparency: boolean;
}

export interface ChromePlan {
	/** `data-material`: `native` paints the translucent veils over the material, `none` the solid ones. */
	readonly material: "native" | "none";
	readonly native: NativeMaterial;
	/** `data-os-version` (Windows only): "10" squares the popup corners. */
	readonly osVersion: "10" | "11" | null;
}

const NONE: NativeMaterial = { kind: "none" };

/** Popup corner radius in points on macOS (DESIGN.md rounded.popup). */
export const MAC_POPUP_RADIUS = 12;

/** What a window of `role` gets in `env`. Pure. */
export function planChrome(role: WindowRole, env: ChromeEnv): ChromePlan {
	const osVersion = env.os === "windows" ? windowsVersion(env.windowsBuild) : null;
	if (role !== "popup" || env.reduceTransparency) return { material: "none", native: NONE, osVersion };
	if (env.os === "macos") {
		return {
			material: "native",
			native: { kind: "mac-effect", material: NS_MATERIAL.popover, radius: MAC_POPUP_RADIUS },
			osVersion,
		};
	}
	if (env.os === "windows" && (env.windowsBuild ?? 0) >= WIN11_22H2_BUILD) {
		return {
			material: "native",
			native: { kind: "win-backdrop", backdrop: DWMSBT.transientWindow, corner: DWMWCP.round },
			osVersion,
		};
	}
	return { material: "none", native: NONE, osVersion };
}

function windowsVersion(build: number | null): "10" | "11" | null {
	if (build === null) return null;
	return build >= WIN11_BUILD ? "11" : "10";
}

/**
 * Whether a window of `role` should be created `transparent: true`. macOS popups always are
 * (the view draws the rounded veil). On Windows only where a backdrop can show through:
 * Windows 10 and 21H2 keep the opaque window GLIM-65 shipped.
 */
export function wantsTransparentWindow(role: WindowRole, os: ChromeOs, windowsBuild: number | null): boolean {
	if (role !== "popup") return false;
	if (os === "macos") return true;
	return os === "windows" && (windowsBuild ?? 0) >= WIN11_22H2_BUILD;
}

/** The theme the views should use, or null to follow the OS (no override). Pure. */
export function themeOverride(setting: ThemeSetting): ResolvedTheme | null {
	return setting === "system" ? null : setting;
}

/** Light / dark for the native parts: the setting, or the OS's own when "system". */
export function nativeDark(setting: ThemeSetting, systemDark: boolean | null): boolean {
	if (setting === "dark") return true;
	if (setting === "light") return false;
	return systemDark ?? false;
}

export interface DomChrome {
	readonly material: "native" | "none";
	readonly osVersion: "10" | "11" | null;
	readonly theme: ResolvedTheme | null;
}

/** JavaScript that sets the chrome attributes on <html> (run in the view). Pure. */
export function domChromeScript(dom: DomChrome): string {
	const set = (name: string, value: string | null) =>
		value === null
			? `d.removeAttribute(${JSON.stringify(name)});`
			: `d.setAttribute(${JSON.stringify(name)},${JSON.stringify(value)});`;
	return `(()=>{const d=document.documentElement;${set("data-material", dom.material)}${dom.osVersion ? set("data-os-version", dom.osVersion) : ""}${set("data-theme", dom.theme)}})();`;
}

/** What the chrome needs from a window. The Electrobun adapter is `electrobunChromeTarget`. */
export interface ChromeTarget {
	/** NSWindow* / HWND, null if the window has none (yet). */
	readonly handle: Pointer | null;
	/** Run a script in the window's view (Electrobun executeJavascript; fire-and-forget). */
	runScript(js: string): void;
	/** Called after each page load, so attributes survive a reload. */
	onDomReady(listener: () => void): void;
}

export interface WindowChromeDeps {
	readonly os: ChromeOs;
	/** Null without a helper (Linux, a missing library): only the DOM attributes are set. */
	readonly native: WindowChromeNative | null;
	readonly theme: () => ThemeSetting;
	readonly log: (message: string) => void;
}

/** One window's chrome. */
export class ChromeHandle {
	#plan: ChromePlan | null = null;
	#cloaked = false;
	#disposed = false;

	constructor(
		private readonly owner: WindowChrome,
		readonly target: ChromeTarget,
		readonly role: WindowRole,
	) {}

	/** The plan in force (after the last apply). */
	get plan(): ChromePlan | null {
		return this.#plan;
	}

	get cloaked(): boolean {
		return this.#cloaked;
	}

	/** Re-read the environment (reduce transparency) and re-apply what changed. Call before a show. */
	refresh(): ChromePlan {
		return this.apply(false);
	}

	/** @internal */
	apply(force: boolean): ChromePlan {
		const plan = planChrome(this.role, this.owner.env());
		const previous = this.#plan;
		this.#plan = plan;
		if (this.#disposed) return plan;
		const handle = this.target.handle;
		const native = this.owner.native;
		if (native && handle && (force || !sameMaterial(previous?.native, plan.native))) {
			this.owner.attempt("material", () => native.setMaterial(handle, plan.native));
		}
		if (force || previous?.material !== plan.material || previous.osVersion !== plan.osVersion) this.applyDom();
		return plan;
	}

	/** @internal Theme changed (or first apply): native appearance + DOM. */
	applyTheme(): void {
		if (this.#disposed) return;
		const native = this.owner.native;
		const handle = this.target.handle;
		const setting = this.owner.theme();
		if (native && handle) {
			this.owner.attempt("appearance", () =>
				native.setAppearance(handle, setting, nativeDark(setting, native.systemDark())),
			);
		}
		this.applyDom();
	}

	/** @internal */
	applyDom(): void {
		if (this.#disposed) return;
		const plan = this.#plan ?? planChrome(this.role, this.owner.env());
		const script = domChromeScript({
			material: plan.material,
			osVersion: plan.osVersion,
			theme: themeOverride(this.owner.theme()),
		});
		this.owner.attempt("view attributes", () => this.target.runScript(script));
	}

	/** Whether this window hides by DWM cloak (Windows popups). */
	get canCloak(): boolean {
		return this.role === "popup" && this.owner.os === "windows" && !!this.owner.native?.setCloaked;
	}

	/** Cloak / uncloak (Windows). Returns false when it couldn't (the caller hides normally). */
	setCloaked(cloaked: boolean): boolean {
		const native = this.owner.native;
		const handle = this.target.handle;
		if (!this.canCloak || !native?.setCloaked || !handle) return false;
		const setCloaked = native.setCloaked.bind(native);
		const ok = this.owner.attempt("cloak", () => setCloaked(handle, cloaked));
		if (ok) this.#cloaked = cloaked;
		return ok;
	}

	/** macOS: one native setFrame (global top-left points). False when unavailable. */
	setFrame(frame: Rect): boolean {
		const native = this.owner.native;
		const handle = this.target.handle;
		if (this.owner.os !== "macos" || !native?.setFrame || !handle) return false;
		const setFrame = native.setFrame.bind(native);
		return this.owner.attempt("frame", () => setFrame(handle, frame));
	}

	/** Windows popups: no resizing by the hiddenInset frame's edges. */
	disableResize(): boolean {
		const native = this.owner.native;
		const handle = this.target.handle;
		if (this.owner.os !== "windows" || !native?.disableResize || !handle) return false;
		const disable = native.disableResize.bind(native);
		return this.owner.attempt("edge hit-testing", () => disable(handle));
	}

	dispose(): void {
		this.#disposed = true;
		this.owner.forget(this);
	}
}

function sameMaterial(a: NativeMaterial | undefined, b: NativeMaterial): boolean {
	return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

export class WindowChrome {
	readonly #handles = new Set<ChromeHandle>();

	constructor(private readonly deps: WindowChromeDeps) {}

	get os(): ChromeOs {
		return this.deps.os;
	}

	get native(): WindowChromeNative | null {
		return this.deps.native;
	}

	theme(): ThemeSetting {
		return this.deps.theme();
	}

	/** The environment now (reduce transparency is read each time; it is a cheap native query). */
	env(): ChromeEnv {
		const native = this.deps.native;
		let windowsBuild: number | null = null;
		let reduceTransparency = false;
		if (native) {
			try {
				windowsBuild = native.windowsBuild();
				reduceTransparency = native.reduceTransparency();
			} catch (e) {
				this.deps.log(`[chrome] environment unreadable: ${message(e)}`);
			}
		}
		return { os: this.deps.os, windowsBuild, reduceTransparency };
	}

	/** Whether a window of `role` should be created transparent on this machine. */
	transparentFor(role: WindowRole): boolean {
		return wantsTransparentWindow(role, this.deps.os, this.env().windowsBuild);
	}

	/** Start managing a window: material + theme now, and again after every page load. */
	attach(target: ChromeTarget, role: WindowRole): ChromeHandle {
		const handle = new ChromeHandle(this, target, role);
		this.#handles.add(handle);
		handle.apply(true);
		handle.applyTheme();
		target.onDomReady(() => handle.applyDom());
		return handle;
	}

	/** The theme setting changed: apply it to every window at once (no restart). */
	themeChanged(): void {
		for (const h of this.#handles) h.applyTheme();
	}

	/** @internal */
	forget(handle: ChromeHandle): void {
		this.#handles.delete(handle);
	}

	/** @internal Run a native step; failures are logged, never thrown (the window still works). */
	attempt(what: string, run: () => void): boolean {
		try {
			run();
			return true;
		} catch (e) {
			this.deps.log(`[chrome] ${what} failed: ${message(e)}`);
			return false;
		}
	}
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
