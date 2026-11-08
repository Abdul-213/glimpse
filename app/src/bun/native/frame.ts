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

/** Sprite flags (frame.m / frame.cpp). */
export const SPRITE_INTERACTIVE = 1;
export const SPRITE_PEEK = 2;

/**
 * GLIM-154: one bitmap the frame paints above its ticks (a numbered badge or an overlay card).
 * `rect` is in the frame's space (`FrameSpace`: macOS global points, Windows physical px).
 */
export interface FrameSprite {
	readonly rect: Rect;
	/** Bitmap size in pixels. */
	readonly width: number;
	readonly height: number;
	/** Premultiplied RGBA, `width * height * 4` bytes. */
	readonly rgba: Uint8Array;
	readonly opacity: number;
	/** SPRITE_INTERACTIVE (hit-tested, catches clicks) | SPRITE_PEEK (fades while hovered). */
	readonly flags: number;
}

/** What `glim_frame_pointer` reports: sprite indices, -1 for none. */
export interface FramePointer {
	readonly hover: number;
	readonly click: number;
}

/** Straight-alpha RGBA (canvas `getImageData`) to premultiplied RGBA, as the helpers take it. */
export function premultiplied(rgba: Uint8Array): Uint8Array {
	const out = new Uint8Array(rgba.length);
	for (let i = 0; i + 3 < rgba.length; i += 4) {
		const a = rgba[i + 3] ?? 0;
		out[i] = Math.round(((rgba[i] ?? 0) * a) / 255);
		out[i + 1] = Math.round(((rgba[i + 1] ?? 0) * a) / 255);
		out[i + 2] = Math.round(((rgba[i + 2] ?? 0) * a) / 255);
		out[i + 3] = a;
	}
	return out;
}

/** The sprites as the C ABI takes them: geom f64[n*5], meta i32[n*3], pixels back to back. */
export function packSprites(sprites: readonly FrameSprite[]): {
	count: number;
	geom: Float64Array;
	meta: Int32Array;
	pixels: Uint8Array;
} {
	const count = sprites.length;
	// Never zero-length: bun:ffi `ptr()` needs a backing store.
	const geom = new Float64Array(Math.max(1, count * 5));
	const meta = new Int32Array(Math.max(1, count * 3));
	let bytes = 0;
	for (const s of sprites) bytes += s.width * s.height * 4;
	const pixels = new Uint8Array(Math.max(1, bytes));
	let off = 0;
	sprites.forEach((s, i) => {
		geom.set([s.rect.x, s.rect.y, s.rect.width, s.rect.height, s.opacity], i * 5);
		meta.set([s.width, s.height, s.flags], i * 3);
		const len = s.width * s.height * 4;
		pixels.set(s.rgba.subarray(0, len), off);
		off += len;
	});
	return { count, geom, meta, pixels: bytes === 0 ? pixels : pixels.subarray(0, bytes) };
}

/** What the pinned frame needs from libglimpse.dylib / glimpse.dll. Faked in tests. */
export interface FrameNativeBinding {
	/**
	 * GLIM-154: replace the badges and cards (count 0 clears them). `peek`: the opacity of a
	 * hovered SPRITE_PEEK sprite. Optional: older fakes have no sprites.
	 */
	frameSetSprites?(handle: FrameHandle, sprites: readonly FrameSprite[], peek: number): void;
	/** GLIM-154: the hovered sprite and the one clicked since the last call. */
	framePointer?(handle: FrameHandle): FramePointer;
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
