// The pinned Live frame's native side (GLIM-90, live-popup.md 2.4 and 12.2): what the helpers
// export (frame.m / frame.cpp) and which coordinate space each OS wants. Like overlay.ts, no
// raw pointer leaves app/src/bun/native/; callers get a `FrameNativeBinding` and a mapper.
import { type CaptureDisplay, type Display, planCapture, type Rect, withNativeBounds } from "@glimpse/core";
import { loadMacNative } from "./macos.ts";
import { loadWindowsCapture, type PhysicalDisplay } from "./windows.ts";

/** Opaque frame handle (an id in the helper, not a pointer). */
export type FrameHandle = bigint;

/** glim_frame_set_style arguments. */
export interface FrameNativeStyle {
	readonly paused: boolean;
	/** RGBA u32[7], see FRAME_PALETTE_ORDER. */
	readonly palette: Uint32Array;
	/** 0 none, 1 live, 2 paused, 3 cloud (egress colour). */
	readonly tag: 0 | 1 | 2 | 3;
	readonly tagText: string;
	readonly tagBelow: boolean;
}

/** What the pinned frame needs from libglimpse.dylib / glimpse.dll. Faked in tests. */
export interface FrameNativeBinding {
	frameCreate(): FrameHandle;
	/** Region in the OS's frame space (see `FrameSpace`), plus the UI scale there. Throws CaptureError. */
	frameSetRect(handle: FrameHandle, region: Rect, scale: number): void;
	frameSetStyle(handle: FrameHandle, style: FrameNativeStyle): void;
	frameSetHighlight(handle: FrameHandle, box: Rect | null): void;
	frameShow(handle: FrameHandle, visible: boolean): void;
	/** CGWindowID / HWND value (0 if none yet). */
	frameWindowId(handle: FrameHandle): number;
	frameDestroy(handle: FrameHandle): void;
	/** What the OS reports for the window (smoke tests, diagnostics); null for an unknown handle. */
	frameInfo(handle: FrameHandle): Record<string, number> | null;
}

/** Order of the colours in the palette the helpers take. */
export const FRAME_PALETTE_ORDER = [
	"accent",
	"picker-halo",
	"picker-stroke",
	"picker-hud",
	"picker-hud-text",
	"box-linked-fill",
	"egress-dark",
] as const;

/** `#RRGGBB` / `#RRGGBBAA` -> RGBA u32. */
export function rgbaOf(hex: string): number {
	const h = hex.replace(/^#/, "");
	if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) throw new Error(`not a colour: ${hex}`);
	return Number.parseInt(h.length === 6 ? `${h}ff` : h, 16) >>> 0;
}

/**
 * Maps a global logical rect to the space `glim_frame_set_rect` takes, with the UI scale
 * there. macOS: global points as they are. Windows: global physical px (the capture
 * geometry's native space), scale = the display's DPI scale. Null when the rect is on no display.
 */
export type FrameSpace = (rect: Rect) => { readonly rect: Rect; readonly scale: number } | null;

export const logicalFrameSpace: FrameSpace = (rect) => ({ rect, scale: 1 });

/** Windows: logical -> physical through the same plan the capture backend uses. Pure. */
export function physicalFrameSpace(displays: () => readonly CaptureDisplay[]): FrameSpace {
	return (rect) => {
		let plan: ReturnType<typeof planCapture>;
		try {
			plan = planCapture(rect, displays(), {});
		} catch {
			return null;
		}
		const pieces = plan.pieces;
		const first = pieces[0];
		if (!first) return null;
		let x0 = Number.POSITIVE_INFINITY;
		let y0 = Number.POSITIVE_INFINITY;
		let x1 = Number.NEGATIVE_INFINITY;
		let y1 = Number.NEGATIVE_INFINITY;
		for (const p of pieces) {
			x0 = Math.min(x0, p.source.x);
			y0 = Math.min(y0, p.source.y);
			x1 = Math.max(x1, p.source.x + p.source.width);
			y1 = Math.max(y1, p.source.y + p.source.height);
		}
		const display = displays().find((d) => d.id === first.displayId);
		return { rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, scale: display?.scaleFactor ?? 1 };
	};
}

export interface FrameNatives {
	readonly binding: FrameNativeBinding | null;
	readonly space: FrameSpace;
	/** For diagnostics: why there is no native frame. */
	readonly status: string;
}

/** The helper's frame functions for this OS, or a reason why there are none. */
export function frameNativesFor(
	shellDisplays: () => readonly Display[],
	platform: string = process.platform,
): FrameNatives {
	if (platform === "darwin") {
		const { binding, status } = loadMacNative();
		return binding
			? { binding, space: logicalFrameSpace, status: "libglimpse.dylib" }
			: { binding: null, space: logicalFrameSpace, status: status.available ? "unavailable" : status.reason };
	}
	if (platform === "win32") {
		const { binding, status } = loadWindowsCapture();
		if (!binding) {
			return { binding: null, space: logicalFrameSpace, status: status.available ? "unavailable" : status.reason };
		}
		let physical: PhysicalDisplay[] = [];
		const displays = () => {
			try {
				physical = binding.physicalDisplays();
			} catch {
				// Keep the last good list.
			}
			return withNativeBounds(shellDisplays(), physical);
		};
		return { binding, space: physicalFrameSpace(displays), status: "glimpse.dll" };
	}
	return { binding: null, space: logicalFrameSpace, status: `no native frame on ${platform}` };
}
