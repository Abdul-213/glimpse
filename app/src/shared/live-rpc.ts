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
//                downloadPack      L12 "Download ({size})" on a pack row: consent to fetch that pack (GLIM-123)
//                blockHovered      the frame lights that block's box (null = none)
//                copyRequested     Ctrl/⌘C, Ctrl/⌘⇧C (manual only: Live never copies by itself)
//                liveBlurred       Esc: hand focus back to the previous app
//                livePointerEntered the pointer came over the popup: focus is saved, so a
//                                  click that activates Glimpse anyway hands it straight back
//                liveDragStart / liveDragMove / liveDragEnd  dragging the strip (GLIM-151)
//                moveRequested     Alt/Option+arrows; dockRequested; pinToggled
//   main → view  liveMoved         a keyboard move / Dock happened: announce it (GLIM-151)
//   view → main  overlayToggled    GLIM-154: overlay mode on / off (strip toggle, Ctrl/⌘⇧T)
//                liveMarks         GLIM-154: the badges and cards for the pinned frame, as
//                                  bitmaps (pixels only for marks main doesn't have yet)
import type { LivePopupState, PopupSide } from "@glimpse/core";
import type { RPCSchema } from "electrobun/view";
import type { Platform } from "./rpc.ts";

/** Once per view load. */
export interface LiveViewInit {
	os: Platform;
	uiLang: string;
	uiDir: "ltr" | "rtl";
	/** Shortcut labels for tooltips, formatted for the OS. */
	keys: {
		pause: string;
		stop: string;
		copy: string;
		copyOriginal: string;
		original: string;
		focus: string | null;
		/** GLIM-154: overlay mode. Absent in older previews. */
		overlay?: string;
	};
}

export interface LiveLayout {
	side: PopupSide;
	/** Fixed for the session (re-pin recomputes it). */
	width: number;
	maxHeight: number;
	/** GLIM-151: the user moved it away from the region (Dock shows). Absent = docked. */
	moved?: boolean;
	/** GLIM-151: above other windows (the Pin toggle). Absent = pinned. */
	pinned?: boolean;
}

/** GLIM-151: a keyboard move or Dock finished; the view announces it politely. */
export interface LiveMovedMessage {
	sessionId: string;
	kind: "moved" | "docked";
	/** Work-area edges it stopped at. */
	edges: ("left" | "right" | "top" | "bottom")[];
}

export type LiveMoveDirection = "up" | "down" | "left" | "right";

export interface LiveStateMessage {
	sessionId: string;
	layout: LiveLayout;
	state: LivePopupState;
	reducedMotion: boolean;
	/** Epoch ms when sent: the stale label's "now" (main re-sends every 30 s while stale). */
	now: number;
	/** The popup has keyboard focus on purpose (Focus Live popup, consent). */
	focused: boolean;
	/**
	 * GLIM-154: the frame can draw numbered badges and overlay cards out of capture. Absent:
	 * no marks (no native frame, or its window isn't confirmed out of capture), and no
	 * numbers or overlay toggle in the popup.
	 */
	marks?: LiveMarksConfig;
}

/** GLIM-154: how the view rasterises marks for the pinned frame. */
export interface LiveMarksConfig {
	/** Sprite pixels per logical px (the region's display). */
	scale: number;
	/** The translations' language, for the cards' script stack and direction. */
	target: string | null;
}

/**
 * GLIM-154: one badge or card for the pinned frame. Global logical px; `image` (straight
 * RGBA, base64) only the first time main sees `key`.
 */
export interface LiveMarkSprite {
	key: string;
	/** The block's id. */
	id: string;
	kind: "badge" | "card";
	x: number;
	y: number;
	width: number;
	height: number;
	opacity: number;
	image?: { width: number; height: number; data: string };
}

export type LiveConsentAnswer = "cloud" | "local" | "cancel";

/** The skipped line's two text buttons (GLIM-131). */
export type LiveSkippedAction = "translateSkipped" | "editSources";

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
			/** The spend guard's "Continue this month" (GLIM-120): resume cloud use, then Live. */
			continueCloudRequested: { sessionId: string };
			privateToggled: { sessionId: string; on: boolean };
			consentAnswered: { sessionId: string; answer: LiveConsentAnswer; remember: boolean };
			skippedToggled: { sessionId: string; expanded: boolean };
			/** GLIM-123: the pack row's Download (the user's consent, GLIM-57). */
			downloadPack: { sessionId: string; lang: string };
			/** GLIM-131: "Translate these" (session-only) / "Edit source languages…". */
			skippedAction: { sessionId: string; action: LiveSkippedAction };
			/** A block is hovered / focused: the frame shows its box (null = none). */
			blockHovered: { sessionId: string; id: string | null };
			copyRequested: { sessionId: string; what: "translation" | "original" };
			liveBlurred: { sessionId: string };
			/** The pointer entered the popup: the game still has focus, remember it (§7.2). */
			livePointerEntered: { sessionId: string };
			/**
			 * GLIM-151 drag on the strip: down, moves (at most one per animation frame, screen
			 * deltas since down; main prefers the OS cursor), up / cancel.
			 */
			liveDragStart: { sessionId: string };
			liveDragMove: { sessionId: string; dx: number; dy: number };
			liveDragEnd: { sessionId: string };
			/** Alt/Option+arrows (Shift = large step). */
			moveRequested: { sessionId: string; direction: LiveMoveDirection; large: boolean };
			/** Dock button or double-click on the strip. */
			dockRequested: { sessionId: string };
			/** The Pin toggle: above other windows or not. */
			pinToggled: { sessionId: string; on: boolean };
			/** GLIM-154: overlay mode on / off. */
			overlayToggled: { sessionId: string; on: boolean };
			/** GLIM-154: every mark on the frame, in paint order (an empty list clears them). */
			liveMarks: { sessionId: string; sprites: LiveMarkSprite[] };
		};
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			liveState: LiveStateMessage;
			liveFocus: { sessionId: string };
			/** GLIM-92: `change` goes to the polite role="log", `status` to role="status". */
			liveAnnounce: { sessionId: string; text: string; kind: "change" | "status" };
			/** GLIM-151: announce a keyboard move / Dock in the polite status region. */
			liveMoved: LiveMovedMessage;
		};
	}>;
};
