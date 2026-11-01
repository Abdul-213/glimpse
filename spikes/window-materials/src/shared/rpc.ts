// Typed RPC schemas. Types only.

import type { RPCSchema } from "electrobun/view";
import type { OsKind } from "./model";

/** What the popup webview should paint. */
export interface PopupLook {
	os: OsKind;
	dark: boolean;
	/** "tint" = surface-popup veil over the material, "solid" = surface-popup-solid. */
	veil: "tint" | "solid";
	/** Veil alpha for the tint (DESIGN.md: 0.9). */
	veilAlpha: number;
	radius: number;
	/** One-line description shown in the popup footer. */
	caption: string;
	/** Bumped by "Show with new content" to test stale-frame flashes. */
	contentSeq: number;
}

export type PopupRPC = {
	bun: RPCSchema<{
		requests: {
			hello: { params: { dpr: number; prefersDark: boolean; prefersReducedTransparency: boolean | null }; response: PopupLook };
		};
		messages: {
			/** Sent after two requestAnimationFrame callbacks following `shown`. */
			frame: { seq: number; visibility: string };
			media: { prefersDark: boolean; prefersReducedTransparency: boolean | null };
			clicked: { what: string };
		};
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			look: PopupLook;
			shown: { seq: number };
		};
	}>;
};

export interface ControlStatus {
	os: OsKind;
	osDetail: string;
	materials: string[];
	showModes: string[];
	cornerOptions: string[];
	settings: Record<string, string>;
	popupVisible: boolean;
	surface: { nativeMaterial: boolean; veil: string; reason: string };
	osReduceTransparency: boolean;
	systemDark: boolean;
	lastShow: Record<string, unknown> | null;
	latency: Record<string, unknown> | null;
	focus: Record<string, unknown> | null;
	log: string[];
	logPath: string;
}

export type ControlRPC = {
	bun: RPCSchema<{
		requests: {
			action: { params: { name: string; value?: string }; response: ControlStatus };
		};
		messages: Record<never, never>;
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			status: ControlStatus;
		};
	}>;
};
