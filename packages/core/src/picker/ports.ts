// What the region picker needs from the OS (docs/design/specs/region-picker.md 7, 9.2,
// 9.3). The app implements these with the native helpers (app/src/bun/services/picker/);
// tests and the Linux harness use the fakes in @glimpse/core/testing.
import type { Point, Rect } from "../geometry.ts";

/** One on-screen window of another app, for snapping and click-to-select. */
export interface ScreenWindow {
	/** Frame bounds without shadow, global logical. */
	readonly rect: Rect;
	readonly pid: number;
	/** Stacking order, 0 = frontmost. Lists are sorted by it. */
	readonly z: number;
	/** The owning app's name for the readout ("Safari"). Never the window title. */
	readonly appName: string;
}

/** Lists windows once per picker open. Fails soft: no list means no window snapping. */
export interface WindowListSource {
	list(): Promise<readonly ScreenWindow[]>;
}

/** The loupe's pixels: `size` x `size` device px of one display, centred on a point. */
export interface LoupePatch {
	/** Global logical point the patch is centred on (the pointer hotspot). */
	readonly centre: Point;
	readonly displayId: number;
	/** Cells per side (15 in the spec). */
	readonly size: number;
	/** RGBA8, `size * size * 4` bytes, top row first. Off-desktop cells are opaque black. */
	readonly rgba: Uint8Array;
	/** Changes when the backend saw new screen content (or every sample if it can't tell). */
	readonly sequence: number;
}

/**
 * Reads loupe pixels from screen capture (never from the webview, which would show the
 * overlay itself). `sample` resolves null while no pixels are available yet; the loupe
 * then shows its empty grid. `stop` releases whatever the sampler keeps warm.
 */
export interface PixelSampler {
	sample(centre: Point, size: number): Promise<LoupePatch | null>;
	stop(): void;
}

/**
 * Remembers the app that had focus at hotkey time and gives focus back on cancel and
 * Live confirm (spec section 7). Both calls are best effort and never throw.
 */
export interface FocusKeeper {
	save(): void;
	/** True when focus was handed back; false when there was nothing to restore. */
	restore(): boolean;
}
