// The Live popup's RPC contract (live-popup.md §12.4), started by GLIM-59 so the docked popup
// (GLIM-79) and its controls (GLIM-81) render what the session already emits. Main pushes one
// message per `LiveSessionEvent` (the core types: status with staleness, frame with block
// upserts + `changed` flags, translation); the view sends intents back. Types only.
//
// GLIM-79 owns the window controller (app/src/bun/windows/live-popup.ts) and the view
// (app/src/views/live/); extend this schema there (open / provider / pack / focus / close,
// painted / resize / consent / copy / announce from the spec) rather than adding a second one.
import type {
	LiveBlock,
	LiveBlockUpdate,
	LiveError,
	LivePauseReason,
	LiveSessionEvent,
	LiveStatus,
} from "@glimpse/core";
import type { RPCSchema } from "electrobun/view";

export type { LiveBlock, LiveBlockUpdate, LiveError, LivePauseReason, LiveSessionEvent, LiveStatus };

export type LiveStatusMessage = Extract<LiveSessionEvent, { type: "status" }>;
export type LiveFrameMessage = Extract<LiveSessionEvent, { type: "frame" }>;
export type LiveTranslationMessage = Extract<LiveSessionEvent, { type: "translation" }>;

export type LiveRPC = {
	bun: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			pauseRequested: { sessionId: string };
			resumeRequested: { sessionId: string };
			stopRequested: { sessionId: string };
			repinRequested: { sessionId: string };
			/** A block is hovered / focused: the frame shows its box (null = none). */
			blockHovered: { sessionId: string; id: string | null };
		};
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			statusChanged: LiveStatusMessage;
			frameUpdated: LiveFrameMessage;
			translationUpdated: LiveTranslationMessage;
		};
	}>;
};
