// The capture port: how core asks for screen pixels. Implemented in the app by the
// Windows (DXGI / GDI), macOS (ScreenCaptureKit) and file-based (Linux harness)
// backends in app/src/bun/services/capture/; tests use ReplayCaptureSource from
// @glimpse/core/testing.
import type { Rect } from "../geometry.ts";
import type { Display } from "../region.ts";

/**
 * One captured image.
 *
 * Pixels are tightly packed RGBA8, top row first, alpha forced to 255
 * (`data.length === width * height * 4`). This is the HWC layout OCR preprocessing
 * starts from. Parts of the rect that are on no display are opaque black.
 */
export interface CaptureFrame {
	/** Output size in pixels. */
	readonly width: number;
	readonly height: number;
	readonly data: Uint8Array;
	/** The global logical rect that was asked for. */
	readonly rect: Rect;
	/**
	 * Output pixels per logical unit. Pixel (px, py) shows the logical point
	 * (rect.x + px / scale, rect.y + py / scale). Defaults to the highest
	 * `scaleFactor` among the displays the rect touches, so Retina / 150 % detail is kept.
	 */
	readonly scale: number;
	/** Displays the rect touched, in plan order. */
	readonly displayIds: readonly number[];
	/** True when part of the rect is on no display (that part is black). */
	readonly partial: boolean;
	/**
	 * Frame counter from the backend. Within one session, an unchanged value means
	 * the backend saw no new screen content since the previous frame (pixels are
	 * identical). One-shot captures and backends that can't tell use a fresh value
	 * every time.
	 */
	readonly sequence: number;
	/** Epoch ms when the pixels were read. */
	readonly capturedAt: number;
}

export interface CaptureOptions {
	/** Output pixels per logical unit. Default: highest scaleFactor the rect touches. */
	readonly scale?: number;
}

export interface CaptureSessionOptions extends CaptureOptions {
	/** Upper bound on how often the backend produces new frames (Live mode: 2-4). */
	readonly fps: number;
}

/**
 * A persistent stream over one rect, for Live mode. Backends keep their expensive
 * state (DXGI duplication, SCStream) alive between frames, so `next()` is cheap and
 * only does real work when the screen changed.
 */
export interface CaptureSession {
	readonly rect: Rect;
	/** The latest frame. Resolves quickly; never waits for the screen to change. */
	next(): Promise<CaptureFrame>;
	/** Stop the stream and release native resources. Idempotent. */
	close(): void;
}

/**
 * How a backend keeps Glimpse's own windows out of its frames.
 * - `window-flag`: the OS hides flagged windows from every capture (Windows
 *   `WDA_EXCLUDEFROMCAPTURE`); `setExcludedWindows` is informational only.
 * - `filter`: the backend's capture filter skips the listed windows (macOS
 *   ScreenCaptureKit `SCContentFilter`); `setExcludedWindows` must be kept current.
 * - `none`: nothing to exclude (file-based backend).
 */
export type CaptureExclusion = "window-flag" | "filter" | "none";

export interface CaptureSource {
	/** Short backend name for diagnostics: `dxgi+gdi`, `screencapturekit`, `file`, `unavailable`. */
	readonly backend: string;
	readonly exclusion: CaptureExclusion;
	/** Current displays in global logical coordinates. Re-read on demand. */
	displays(): readonly Display[];
	/** One-shot capture (Snip mode). `rect` is in global logical coordinates. */
	capture(rect: Rect, options?: CaptureOptions): Promise<CaptureFrame>;
	/** Persistent capture of one rect (Live mode). Close it when done. */
	openSession(rect: Rect, options: CaptureSessionOptions): Promise<CaptureSession>;
	/**
	 * The native ids of every Glimpse window that is currently open (macOS
	 * `CGWindowID` = `NSWindow.windowNumber`; Windows `HWND` value). Pass the full
	 * set each time it changes; running sessions pick up the change.
	 */
	setExcludedWindows(windowIds: readonly number[]): void;
	/** Close all sessions and release native resources. */
	dispose(): void;
}

export type CaptureErrorCode =
	/** No backend on this machine (native helper missing or failed to load). */
	| "unavailable"
	/** macOS Screen Recording not granted (or granted to an older build). */
	| "permission-denied"
	/** The rect is not on any display, or a display went away. */
	| "no-display"
	/** The OS refused for now: secure desktop (UAC, lock screen), mode switch. Retry later. */
	| "temporarily-unavailable"
	| "timeout"
	| "invalid-argument"
	| "failed";

export class CaptureError extends Error {
	override readonly name = "CaptureError";
	constructor(
		readonly code: CaptureErrorCode,
		message: string,
		/** Native status (HRESULT, OSStatus, NSError code or a glim_ code), when there is one. */
		readonly status?: number,
	) {
		super(message);
	}
}

export const isCaptureError = (e: unknown): e is CaptureError => e instanceof CaptureError;
