// Typed RPC contracts between the Bun main process and each webview.
// One schema per surface. Types only: imported with `import type` on both sides, so
// nothing from electrobun/view leaks into the main bundle or vice versa.
//
// Convention (ARCHITECTURE.md "Views and RPC"):
//   bun.requests      view -> main, awaited       (view calls rpc.request.<name>)
//   bun.messages      view -> main, fire-and-forget (rpc.send.<name>)
//   webview.requests  main -> view, awaited
//   webview.messages  main -> view, fire-and-forget (pushes: state, theme changes)
// Payloads are plain JSON data. Domain types come from @glimpse/core.

import type { PickerMode, PickerViewState, ResultsLayerState } from "@glimpse/core";
import type { RPCSchema } from "electrobun/view";

export type Platform = "macos" | "windows" | "linux";

export interface AppInfo {
	name: string;
	version: string;
	platform: Platform;
	electrobun: string;
	bun: string;
}

// Settings (GLIM-69) lives in its own file; re-exported so `import type { SettingsRPC } from "./rpc.ts"` keeps working.
export type { SettingsRPC } from "./settings-rpc.ts";

// ---- Region picker (GLIM-44; docs/design/specs/region-picker.md 9.4) ------------------
// Main owns the picker state (PickerSession) and pushes the derived view to every overlay;
// views send raw input in their own display-local CSS px.

/** Once per view load, the answer to getPickerInit. */
export interface PickerViewInit {
	displayId: number;
	/** Display origin, global logical (the view subtracts it from every global coordinate). */
	origin: { x: number; y: number };
	size: { width: number; height: number };
	scaleFactor: number;
	os: Platform;
	uiDir: "ltr" | "rtl";
}

export interface PickerModifiers {
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	meta: boolean;
}

export interface PickerPointerMessage {
	displayId: number;
	phase: "down" | "move" | "up" | "leave";
	/** Display-local CSS px (may be outside the view during pointer capture). */
	x: number;
	y: number;
	button: number;
	detail: number;
	mods: PickerModifiers;
}

export interface PickerKeyMessage {
	displayId: number;
	key: string;
	down: boolean;
	repeat: boolean;
	mods: PickerModifiers;
}

/** The loupe's 15 x 15 device px, ≤ 30 Hz, latest wins. The one deliberate pixel payload (900 bytes). */
export interface PickerLoupeMessage {
	seq: number;
	displayId: number;
	size: number;
	/** base64 of size * size * 4 RGBA bytes. */
	rgba: string;
}

/** Per-open settings the view needs (pushed with every reset, before the window shows). */
export interface PickerOpenInfo {
	mode: PickerMode;
	reducedMotion: boolean;
	/** Settings › Show magnifier. */
	showLoupe: boolean;
}

export type PickerRPC = {
	bun: RPCSchema<{
		requests: {
			/** The view reports what it got, so a window that doesn't cover its display or renders at the wrong scale is logged (GLIM-54). */
			getPickerInit: {
				params: { displayId: number; devicePixelRatio?: number; innerWidth?: number; innerHeight?: number };
				response: PickerViewInit | null;
			};
		};
		messages: {
			pickerPointer: PickerPointerMessage;
			pickerKey: PickerKeyMessage;
			pickerFocus: { displayId: number; focused: boolean };
			pickerModeClicked: { mode: PickerMode };
			pickerHintHover: { displayId: number; over: boolean };
			/** The view's measured hint bar and readout chip (they size to their copy). */
			pickerMeasured: {
				displayId: number;
				hint?: { width: number; height: number };
				readout?: { text: string; width: number; height: number };
			};
		};
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			pickerReset: PickerOpenInfo;
			pickerState: PickerViewState;
			pickerLoupe: PickerLoupeMessage;
			pickerHide: { animate: boolean };
			/** Results layer under the Snip popup: detection boxes and the linked one (GLIM-115); null clears. */
			pickerResults: { results: ResultsLayerState | null };
		};
	}>;
};
