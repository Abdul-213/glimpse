// Typed RPC schema shared by the Bun main process and every overlay webview.
// Types only; emits no runtime code.

import type { RPCSchema } from "electrobun/view";
import type { Point, Rect } from "./geometry";
import type { PickerPhase } from "./picker";

export interface ViewReady {
	displayId: number;
	devicePixelRatio: number;
	innerWidth: number;
	innerHeight: number;
	screenX: number;
	screenY: number;
	userAgent: string;
	hasFocus: boolean;
}

export interface ViewPointer {
	displayId: number;
	phase: "down" | "move" | "up" | "leave";
	/** Local CSS px inside this view (may be outside the viewport during capture). */
	x: number;
	y: number;
	buttons: number;
	/** performance.now() in the view, for latency diagnostics. */
	t: number;
}

export interface ViewKey {
	displayId: number;
	key: string;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	meta: boolean;
}

export interface OverlayState {
	phase: PickerPhase;
	/** Global logical selection, or null. Each view subtracts its own display origin. */
	selection: Rect | null;
	/** Global logical cursor, or null. */
	cursor: Point | null;
	/** Display that should draw the size label (the one under the cursor). */
	labelDisplayId: number | null;
	label: string;
	/** The view pointer event that produced this state, so the view can measure RPC round-trip. */
	echo: { displayId: number; t: number } | null;
}

export interface ViewInit {
	displayId: number;
	/** Display origin in global logical coordinates. */
	origin: Point;
	scaleFactor: number;
	isPrimary: boolean;
	dimAlpha: number;
	showLoupeHint: boolean;
}

export type OverlayRPC = {
	bun: RPCSchema<{
		requests: {
			hello: { params: ViewReady; response: ViewInit };
		};
		messages: {
			pointer: ViewPointer;
			key: ViewKey;
			focus: { displayId: number; focused: boolean };
		};
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: {
			state: OverlayState;
			reset: Record<string, never>;
		};
	}>;
};
