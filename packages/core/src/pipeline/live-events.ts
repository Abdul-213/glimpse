// What a running Live session tells the rest of the app (the docked popup, GLIM-79/81; the
// tray; logs). Plain data, RPC-safe (epoch ms, no classes). Names follow live-popup.md §12.4:
// `status` (strip + staleness), `frame` (one settled capture: block upserts, removes, order,
// change set) and `translation` (a block's translation arriving after its `frame`).

import type { Rect } from "../geometry.ts";
import type { LiveBlockUpdate } from "../popup/live-diff.ts";
import type { ProviderRef } from "../providers/provenance.ts";

/** live-popup.md §4, the states the session itself knows about. */
export type LiveStatus =
	/** Pinned; the first capture is being read (L0). */
	| "starting"
	/** Capturing and fresh (L1, L2, L4). */
	| "live"
	/** A settled change has been processing for over 1 s (L3). */
	| "updating"
	/** No text in the region for 5 s (L7). */
	| "empty"
	/** Not capturing: the user paused, the screen is locked, or capture is briefly unavailable (L5, L17). */
	| "paused"
	/** Not capturing because something failed; `resume()` tries again (L14-L16, L-gone). */
	| "error"
	| "stopped";

export type LivePauseReason = "user" | "locked" | "sleep" | "unavailable";

export type LiveErrorKind =
	/** macOS Screen Recording revoked (L15). */
	| "screenAccess"
	/** The region's display went away (L-gone). */
	| "areaGone"
	| "captureFailed"
	/** OCR failed or no OCR engine (L16). */
	| "ocrFailed";

export interface LiveError {
	readonly kind: LiveErrorKind;
	/** Developer detail, never screen text. */
	readonly message: string;
}

/** Where this session's text goes (the popup's local indicator or cloud row, live-popup.md §2.3). */
export interface LiveSessionProviders {
	/** The cloud provider the session sends to, or null when everything stays on this device. */
	readonly cloud: ProviderRef | null;
	/** "Use on-device" was chosen at consent: cloud providers are skipped for this session. */
	readonly localOnly: boolean;
}

export type LiveSessionEvent =
	/**
	 * A region was pinned (GLIM-79): the popup opens docked to `region` (global logical). Comes
	 * before the session's first `status`, and again with the same id once consent is answered.
	 */
	| {
			readonly type: "opened";
			readonly sessionId: string;
			readonly region: Rect;
			readonly providers: LiveSessionProviders;
			readonly private: boolean;
	  }
	/**
	 * A cloud provider would be used (live-popup.md L10, `liveCloudConsent`): nothing is captured
	 * until the popup's question is answered (`LiveService.answerConsent`).
	 */
	| {
			readonly type: "consent";
			readonly sessionId: string;
			readonly providers: readonly ProviderRef[];
			readonly canRemember: boolean;
			readonly reason: "cloud-ocr" | "cloud-translation";
	  }
	| {
			readonly type: "status";
			readonly sessionId: string;
			readonly status: LiveStatus;
			readonly reason: LivePauseReason | null;
			readonly error: LiveError | null;
			/** Not capturing: the popup dims and says how old the text is (live-popup.md §4 Staleness). */
			readonly stale: boolean;
			/** Epoch ms of the capture the shown blocks come from, or null before the first. */
			readonly capturedAt: number | null;
			readonly at: number;
	  }
	| {
			readonly type: "frame";
			readonly sessionId: string;
			/** Counts settled captures; the view drops older `translation`s for a block. */
			readonly frameSeq: number;
			readonly upserts: readonly LiveBlockUpdate[];
			readonly removes: readonly string[];
			readonly order: readonly string[];
			readonly changeSet: readonly string[];
			readonly capturedAt: number;
			/** Served from the frame ring (GLIM-20): no OCR ran. */
			readonly reused: boolean;
			/** The pinned region (global logical) and the image size the block boxes are in. */
			readonly region: Rect;
			readonly image: { readonly width: number; readonly height: number };
	  }
	| {
			readonly type: "translation";
			readonly sessionId: string;
			readonly frameSeq: number;
			readonly id: string;
			readonly text: string;
			readonly final: boolean;
			readonly failed: boolean;
	  };

export type LiveSessionListener = (event: LiveSessionEvent) => void;

/** One grab as the session handled it (harness, debug logs). No pixels, no text. */
export interface LiveTrace {
	readonly index: number;
	readonly at: number;
	readonly sequence: number;
	readonly sequenceChanged: boolean;
	readonly decision: "first" | "same" | "settling" | "settled" | "below-threshold";
	readonly reason?: "moving" | "waiting" | "stable" | "resume";
	/** Changed fraction of the motion diff (settling) or the baseline diff (settled / below). */
	readonly fraction?: number;
	/** ocr: OCR ran; reused: frame ring hit; blank: an all-black frame, nothing to read. */
	readonly action: "none" | "ocr" | "reused" | "blank";
	readonly grabMs: number;
	/** Change detection on this frame (diffs + hashing), ms. */
	readonly detectMs: number;
}
