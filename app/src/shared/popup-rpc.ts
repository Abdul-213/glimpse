// Snip popup RPC (GLIM-65; snip-popup.md §13.2). Types only, plain JSON.
//
// Main owns the popup state (`SnipPopupState`, reduced from pipeline events in
// @glimpse/core) and pushes all of it on every change, coalesced per turn: a Snip is a
// few dozen blocks of text at most. The view renders it and sends intents back.
//
//   main → view  snipState      the whole state + layout; a new requestId resets the view
//   view → main  snipPainted    the view has painted a new request (two rAFs): show the window
//                snipResized    natural content height, at most once per frame
//                snipDismiss    Esc or Close
//                snipSkipped    expand / collapse the skipped line
//                snipAction     an error-body, pack-row or skipped-line button (§4.1, §12)
//                snipRetryBlock "Retry" on one failed block
//                snipOriginal   original view on/off (Ctrl/⌘⇧O or the footer toggle)
//                snipCopy       copy again (Ctrl/⌘C, Copy button) or the original (Ctrl/⌘⇧C)
//                snipHoverBlock a block is hovered or focused (null: none); its box lights on screen (GLIM-115)
import type { PopupSide, SnipPopupState } from "@glimpse/core";
import type { RPCSchema } from "electrobun/view";
import type { Platform } from "./rpc.ts";

/** Once per view load. */
export interface SnipViewInit {
	os: Platform;
	/** UI language and direction for the chrome (block text sets its own). */
	uiLang: string;
	uiDir: "ltr" | "rtl";
	/** Shortcut labels for tooltips, formatted for the OS ("⌘C", "Ctrl+C"). */
	keys: { copy: string; copyOriginal: string; original: string; close: string };
}

export interface SnipLayout {
	side: PopupSide;
	/** Fixed for the request. */
	width: number;
	maxHeight: number;
}

export interface SnipStateMessage {
	requestId: string;
	layout: SnipLayout;
	state: SnipPopupState;
	/** Glimpse's motion setting resolved: true = no scale, no crossfade. */
	reducedMotion: boolean;
	/** The cloud badge provider's short name ("Google", its vendor), for a narrow footer (GLIM-80). */
	providerShortName: string | null;
	/** E3 can offer "Translate on this device": local packs for every needed pair are installed. */
	localAvailable: boolean;
}

/** Buttons the popup offers (snip-popup.md §12). `download` carries the pack's language. */
export type SnipAction =
	| "snipAgain"
	| "close"
	| "download"
	| "copyOriginal"
	| "retry"
	/** E3 "Translate on this device" (GLIM-80): this Snip only, through the local translators. */
	| "local"
	| "checkKey"
	/** Spend guard (GLIM-120) "Continue this month": resume cloud use, then retry. */
	| "continueCloud"
	| "openSystemSettings"
	| "why"
	| "translateSkipped"
	| "editSources"
	/** GLIM-126: on-device OCR loses part of a language's letters; Settings › Providers offers cloud OCR. */
	| "ocrSettings";

export const SNIP_ACTIONS: readonly SnipAction[] = [
	"snipAgain",
	"close",
	"download",
	"copyOriginal",
	"retry",
	"local",
	"checkKey",
	"continueCloud",
	"openSystemSettings",
	"why",
	"translateSkipped",
	"editSources",
	"ocrSettings",
];

export type SnipDismissReason = "esc" | "close" | "outside" | "blur" | "hotkey";

export type SnipPopupRPC = {
	bun: RPCSchema<{
		requests: {
			getSnipInit: { params: undefined; response: SnipViewInit };
		};
		messages: {
			snipPainted: { requestId: string };
			snipResized: { requestId: string; contentHeight: number };
			snipDismiss: { requestId: string; reason: "esc" | "close" };
			snipSkipped: { requestId: string; expanded: boolean };
			snipAction: { requestId: string; action: SnipAction; lang?: string };
			snipRetryBlock: { requestId: string; blockId: string };
			snipOriginal: { requestId: string; on: boolean };
			snipCopy: { requestId: string; what: "translation" | "original" };
			snipHoverBlock: { requestId: string; blockId: string | null };
		};
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			snipState: SnipStateMessage;
		};
	}>;
};
