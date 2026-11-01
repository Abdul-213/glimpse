// GLIM-41: what the tray / menu-bar item shows, as a pure function of app state
// (docs/design/flows/tray.html T1–T3; live-popup spec §6 "Tray items mirror them").
// tray.ts renders it with Electrobun; this module has no electrobun imports so the menu,
// the icon choice and the rebuild-on-change logic are tested on Linux.
//
// Same items and order on both OSes; labels follow each OS (macOS menus use Title Case,
// Windows sentence case). Status lines are disabled items at the top. Snip and Live items
// always work, even when their shortcut couldn't be registered.

import type { Platform } from "../shared/rpc.ts";
import type { Command } from "./commands.ts";

export type LiveState = "off" | "running" | "paused";
export type TaskbarTheme = "light" | "dark";

export interface TrayState {
	readonly platform: Platform;
	readonly live: LiveState;
	/** App-wide Private mode (GLIM-20; live-popup spec: the tray and the popup toggle share it). */
	readonly private: boolean;
	/** The first provider in the translation chain, or null when none is installed. */
	readonly translation: { readonly name: string; readonly kind: "local" | "cloud" } | null;
	/** The selected OCR provider when it is a cloud one (GLIM-80: screen images leave the device). */
	readonly cloudOcr?: string | null;
	/** Canonical hotkeys from settings (`Alt+Shift+S`), null when unset. */
	readonly hotkeys: { readonly snip: string | null; readonly live: string | null };
	/** Windows only: the taskbar's theme, which picks the light or dark glyph. */
	readonly taskbarTheme: TaskbarTheme;
	/** A newer release on GitHub (GLIM-70), or null/absent when there is none or checks are off. */
	readonly update?: { readonly version: string } | null;
	/** Things that need the user, listed first (flows/tray.html: "problems are listed first"). */
	readonly notices?: readonly TrayNotice[];
}

/** A problem or unfinished step with the command that fixes it ("Allow Screen Access…"). */
export interface TrayNotice {
	/** Per OS: Windows menus use sentence case, macOS Title Case. */
	readonly label: { readonly windows: string; readonly macos: string };
	readonly action: Command;
}

/** Electrobun's tray menu item shape (`MenuItemConfig`), restated so this module stays pure. */
export type TrayMenuItem =
	| { readonly type: "divider" }
	| {
			readonly type: "normal";
			readonly label: string;
			readonly action?: Command;
			readonly enabled?: boolean;
			readonly checked?: boolean;
			readonly tooltip?: string;
			readonly submenu?: readonly TrayMenuItem[];
	  };

const MAC_GLYPHS: Readonly<Record<string, string>> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Cmd: "⌘", Meta: "⌘" };

/** `Ctrl+Shift+S` -> `⌃⇧S` on macOS; unchanged on Windows. */
export function hotkeyLabel(platform: Platform, hotkey: string): string {
	if (platform !== "macos") return hotkey;
	const parts = hotkey.split("+");
	const key = parts.pop() ?? "";
	return `${parts.map((p) => MAC_GLYPHS[p] ?? p).join("")}${key}`;
}

/**
 * The visible label. Windows menus right-align text after a tab as the shortcut (Win32
 * convention). Electrobun tray items have no key-equivalent field on macOS, and a tab in an
 * NSMenuItem title doesn't align, so macOS shows no shortcut text (it is in Settings).
 */
function withShortcut(platform: Platform, label: string, hotkey: string | null): string {
	return platform === "windows" && hotkey ? `${label}\t${hotkeyLabel(platform, hotkey)}` : label;
}

export function statusLine(state: TrayState): string {
	const where = state.platform === "macos" ? "on this Mac" : "on this computer";
	const cloudWord = state.platform === "macos" ? "Cloud" : "cloud";
	const cloud = state.translation?.kind === "cloud" || !!state.cloudOcr;
	const engine =
		state.translation?.kind === "cloud"
			? `☁ ${state.translation.name} (${cloudWord})`
			: state.cloudOcr
				? `☁ ${state.cloudOcr} (${cloudWord})`
				: where;
	switch (state.live) {
		case "running":
			return `● Live is watching a region · ${engine}`;
		case "paused":
			return `❚❚ Live is paused · ${engine}`;
		default:
			if (!cloud) return `Glimpse · ${where}`;
			return state.translation?.kind === "cloud"
				? `Glimpse · translating with ${engine}`
				: `Glimpse · reading text with ${engine}`;
	}
}

/** Short text for the provider line and tooltips. */
export function providerLine(state: TrayState): string {
	if (!state.translation) return "No translation provider installed";
	const translator = `Translator: ${state.translation.name}${state.translation.kind === "cloud" ? " (cloud)" : ""}`;
	return state.cloudOcr ? `${translator} · Text reading: ${state.cloudOcr} (cloud)` : translator;
}

export function buildTrayMenu(state: TrayState): TrayMenuItem[] {
	const mac = state.platform === "macos";
	const t = (sentence: string, title: string) => (mac ? title : sentence);
	const item = (label: string, action: Command, extra: Partial<Extract<TrayMenuItem, { type: "normal" }>> = {}) =>
		({ type: "normal", label, action, ...extra }) as const;
	const status = (label: string) => ({ type: "normal", label, enabled: false }) as const;

	const live: TrayMenuItem[] =
		state.live === "off"
			? [
					item(
						withShortcut(state.platform, t("Live: pin a region", "Live: Pin a Region"), state.hotkeys.live),
						"live.start",
					),
				]
			: [
					state.live === "running"
						? item(t("Pause Live", "Pause Live"), "live.pause")
						: item(t("Resume Live", "Resume Live"), "live.resume"),
					item(withShortcut(state.platform, t("Stop Live", "Stop Live"), state.hotkeys.live), "live.stop"),
				];

	const notices: TrayMenuItem[] = (state.notices ?? []).map((n) =>
		item(mac ? n.label.macos : n.label.windows, n.action),
	);
	// GLIM-70: a newer release opens its download page; nothing is downloaded by Glimpse.
	const update: TrayMenuItem[] = state.update
		? [
				item(`Download Glimpse ${state.update.version}…`, "update.open", {
					tooltip: "Opens the release page in your browser",
				}),
			]
		: [];

	return [
		...notices,
		...(notices.length > 0 ? [{ type: "divider" } as const] : []),
		status(statusLine(state)),
		status(providerLine(state)),
		...update,
		{ type: "divider" },
		item(withShortcut(state.platform, "Snip", state.hotkeys.snip), "snip.start"),
		...live,
		item("Private", "private.toggle", {
			checked: state.private,
			tooltip: "Translations aren't remembered while Private is on",
		}),
		{ type: "divider" },
		item(t("Clear translation cache", "Clear Translation Cache"), "cache.clear"),
		item("Settings…", "settings.open"),
		{
			type: "normal",
			label: "Troubleshooting",
			submenu: [
				item(t("Copy diagnostics", "Copy Diagnostics"), "diagnostics.copy"),
				item(t("Open logs folder", "Open Logs Folder"), "logs.open"),
			],
		},
		{ type: "divider" },
		item("Quit Glimpse", "app.quit"),
	];
}

/** "Finish setting up…" while first-run setup is unfinished (GLIM-76), skipped or not. */
export function finishSetupNotice(onboarding: { readonly completed: boolean }): TrayNotice | null {
	return onboarding.completed
		? null
		: { label: { windows: "Finish setting up…", macos: "Finish Setting Up…" }, action: "onboarding.open" };
}

/**
 * Tray icon (DESIGN.md Shapes: monochrome). macOS: a template image the system tints for the
 * menu bar. Windows: the light glyph on a dark taskbar, the dark glyph on a light one. Linux
 * (dev only): dark glyph. PNGs are copied to views://assets/ by electrobun.config.ts.
 */
export function trayIconFor(
	platform: Platform,
	taskbarTheme: TaskbarTheme = "dark",
): { image: string; template: boolean } {
	switch (platform) {
		case "macos":
			return { image: "views://assets/tray-template.png", template: true };
		case "windows":
			return {
				image: taskbarTheme === "light" ? "views://assets/tray-dark.png" : "views://assets/tray-light.png",
				template: false,
			};
		default:
			return { image: "views://assets/tray-dark.png", template: false };
	}
}

/** The native side tray.ts wraps (Electrobun `Tray`). */
export interface TrayHost {
	setMenu(menu: TrayMenuItem[]): void;
	setImage(image: string): void;
}

/** Holds tray state and pushes only what changed to the host. */
export class TrayController {
	#state: TrayState;
	#menuKey = "";
	#image = "";
	readonly #host: TrayHost;
	/** Count of native menu rebuilds (tests). */
	rebuilds = 0;

	constructor(host: TrayHost, initial: TrayState) {
		this.#host = host;
		this.#state = initial;
		this.#render();
	}

	get state(): TrayState {
		return this.#state;
	}

	update(patch: Partial<TrayState>): void {
		this.#state = { ...this.#state, ...patch };
		this.#render();
	}

	#render(): void {
		const menu = buildTrayMenu(this.#state);
		const key = JSON.stringify(menu);
		if (key !== this.#menuKey) {
			this.#menuKey = key;
			this.#host.setMenu(menu);
			this.rebuilds++;
		}
		const { image } = trayIconFor(this.#state.platform, this.#state.taskbarTheme);
		if (image !== this.#image) {
			// The first image is set by the Tray constructor; later changes go through setImage.
			if (this.#image !== "") this.#host.setImage(image);
			this.#image = image;
		}
	}
}
