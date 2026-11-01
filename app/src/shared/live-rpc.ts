// The docked Live popup's RPC contract (GLIM-79/81/82/92; live-popup.md §12.4). Types only,
// plain JSON.
//
// Main owns the popup state: the session's `LiveSessionEvent`s and the user's intents fold
// into a `LivePopupState` (@glimpse/core `reduceLivePopup`) in the window controller
// (app/src/bun/windows/live-popup-controller.ts), which pushes it to the view, coalesced per
// turn. The view reconciles it by block id (solid-js/store `reconcile`), so unchanged blocks
// keep their DOM nodes and only changed blocks re-render and flash.
//
//   main → view  liveState         the state + layout + the clock for the stale age
//                liveFocus         "Focus Live popup": move DOM focus to Pause / Resume
//                liveAnnounce      one coalesced announcement for the view's role="log" (§10)
//   view → main  livePainted       the view painted a new session (two rAFs): show inactive
//                liveResized       natural content height, at most once per frame
//                pauseRequested / resumeRequested / stopRequested / repinRequested
//                privateToggled    the strip's Private toggle (app-wide, shared with the tray)
//                consentAnswered   L10: cloud / local / cancel (+ "Don't ask again")
//                skippedToggled    the "N blocks skipped" line expanded / collapsed
//                blockHovered      the frame lights that block's box (null = none)
//                copyRequested     Ctrl/⌘C, Ctrl/⌘⇧C (manual only: Live never copies by itself)
//                liveBlurred       Esc: hand focus back to the previous app
//                livePointerEntered the pointer came over the popup: focus is saved, so a
//                                  click that activates Glimpse anyway hands it straight back
import type { LivePopupState, PopupSide } from "@glimpse/core";
import type { RPCSchema } from "electrobun/view";
import type { Platform } from "./rpc.ts";

/** Once per view load. */
export interface LiveViewInit {
	os: Platform;
	uiLang: string;
	uiDir: "ltr" | "rtl";
	/** Shortcut labels for tooltips, formatted for the OS. */
	keys: { pause: string; stop: string; copy: string; copyOriginal: string; original: string; focus: string | null };
}

export interface LiveLayout {
	side: PopupSide;
	/** Fixed for the session (re-pin recomputes it). */
	width: number;
	maxHeight: number;
}

export interface LiveStateMessage {
	sessionId: string;
	layout: LiveLayout;
	state: LivePopupState;
	reducedMotion: boolean;
	/** Epoch ms when sent: the stale label's "now" (main re-sends every 30 s while stale). */
	now: number;
	/** The popup has keyboard focus on purpose (Focus Live popup, consent). */
	focused: boolean;
}

export type LiveConsentAnswer = "cloud" | "local" | "cancel";

export type LiveRPC = {
	bun: RPCSchema<{
		requests: {
			getLiveInit: { params: undefined; response: LiveViewInit };
		};
		messages: {
			livePainted: { sessionId: string };
			liveResized: { sessionId: string; contentHeight: number };
			pauseRequested: { sessionId: string };
			resumeRequested: { sessionId: string };
			stopRequested: { sessionId: string };
			repinRequested: { sessionId: string };
			privateToggled: { sessionId: string; on: boolean };
			consentAnswered: { sessionId: string; answer: LiveConsentAnswer; remember: boolean };
			skippedToggled: { sessionId: string; expanded: boolean };
			/** A block is hovered / focused: the frame shows its box (null = none). */
			blockHovered: { sessionId: string; id: string | null };
			copyRequested: { sessionId: string; what: "translation" | "original" };
			liveBlurred: { sessionId: string };
			/** The pointer entered the popup: the game still has focus, remember it (§7.2). */
			livePointerEntered: { sessionId: string };
		};
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			liveState: LiveStateMessage;
			liveFocus: { sessionId: string };
			liveAnnounce: { sessionId: string; text: string };
		};
	}>;
};
