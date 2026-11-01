// Keeps Glimpse's windows out of screen capture (GLIM-36, from the GLIM-16 spike).
// Window controllers call `protect(win, show, { role })` instead of showing a window directly:
//
//   Windows  SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) before the window is
//            shown, so it never appears in a frame. The DWM then leaves it out of GDI,
//            DXGI and WGC captures: Glimpse's own and every other app's (screenshots,
//            screen sharing). Needs Windows 10 2004 (build 19041); older builds show a
//            black box instead, which the affinity read-back reports.
//   macOS    NSWindow.sharingType = none (legacy capture, other apps on macOS 14), and the
//            window's CGWindowID goes to the capture source, whose ScreenCaptureKit filter
//            excludes it from Glimpse's own capture. SCK ignores sharingType on macOS 15+,
//            so Glimpse windows may still show in other apps' screenshots there.
//
// GLIM-98, Settings › Privacy › "Hide Glimpse from screenshots and screen sharing" (on by
// default). Turning it off un-flags `popup` and `window` windows, so the user's own
// screenshots and screen shares show them. `surface` windows (picker overlays, the results
// layer, the Live frame) stay flagged either way: they sit on top of what Glimpse captures.
// Glimpse's own capture still never reads its windows:
//   macOS    the SCK filter skips every registered window id, whatever sharingType says.
//   Windows  the flag is all or nothing, so `maskRects()` lists the on-screen bounds of every
//            un-flagged window that gave them (the popups), and `MaskedCaptureSource` paints
//            those parts of each frame over before OCR. It also covers a flag that didn't
//            stick (old Windows builds).
//
// No electrobun import: a BrowserWindow satisfies ExcludableWindow structurally, and the
// OS calls come in as ExclusionOps, so this is unit-tested with fakes.
import type { Pointer } from "bun:ffi";
import type { Rect } from "@glimpse/core";

export interface ExcludableWindow {
	/** Electrobun BrowserWindow.ptr: HWND on Windows, NSWindow* on macOS. */
	readonly ptr: Pointer | null;
	on(name: "close", handler: (event: unknown) => void): void;
}

export interface ExclusionOps {
	/** Flag the window. Returns its native id for the capture filter (null if it has none yet). Throws on failure. */
	exclude(handle: Pointer): { excluded: boolean; windowId: number | null; detail: string };
	/** The window's native id once it is on screen (macOS assigns it on first show). */
	windowId(handle: Pointer): number | null;
	/** Flag or un-flag a window that is already open (GLIM-98). Throws on failure. */
	setHidden(handle: Pointer, hidden: boolean): { excluded: boolean; detail: string };
	/**
	 * Glimpse's own capture skips registered window ids whatever the flag says (macOS SCK
	 * filter). When false (Windows), an un-flagged window shows in Glimpse's frames too.
	 */
	readonly ownCaptureSkipsIds: boolean;
}

export interface ExclusionSink {
	setExcludedWindows(windowIds: readonly number[]): void;
}

export interface ProtectResult {
	readonly excluded: boolean;
	readonly windowId: number | null;
	readonly detail: string;
}

/**
 * - `surface`  drawn over what Glimpse captures (picker overlays, results layer): always flagged.
 * - `popup`    Snip and Live popups: follow the setting; masked out of Glimpse's frames when shown.
 * - `window`   Settings, onboarding: follow the setting.
 */
export type ExclusionRole = "surface" | "popup" | "window";

export interface ProtectOptions {
	readonly role?: ExclusionRole;
	/** Where the window is on screen (global logical), or null while hidden. Popups give this. */
	readonly bounds?: () => Rect | null;
}

interface Entry {
	readonly handle: Pointer | null;
	readonly role: ExclusionRole;
	readonly bounds: (() => Rect | null) | undefined;
	excluded: boolean;
}

export class CaptureExclusion {
	private readonly ids = new Set<number>();
	private readonly windows = new Set<Entry>();
	private hidden = true;

	constructor(
		private readonly ops: ExclusionOps | null,
		private readonly sink: ExclusionSink,
		private readonly log: (message: string) => void = () => {},
	) {}

	/** Currently registered native window ids. */
	get windowIds(): readonly number[] {
		return [...this.ids];
	}

	/** Settings › "Hide Glimpse from screenshots and screen sharing". */
	get hideFromCapture(): boolean {
		return this.hidden;
	}

	/**
	 * Apply the setting to every open window and to windows shown from now on. Surfaces stay
	 * flagged. Call once at startup (before windows show) and on every change.
	 */
	setHideFromCapture(hidden: boolean): void {
		if (hidden === this.hidden) return;
		this.hidden = hidden;
		for (const e of this.windows) {
			if (e.role === "surface" || !e.handle || !this.ops) continue;
			try {
				e.excluded = this.ops.setHidden(e.handle, hidden).excluded;
			} catch (error) {
				this.log(`[capture] could not change a window's capture visibility: ${String(error)}`);
			}
		}
	}

	/**
	 * Parts of the screen Glimpse's own capture must paint over (global logical): un-flagged
	 * windows that are on screen, when the backend can't skip them by id.
	 */
	maskRects(): Rect[] {
		if (!this.ops || this.ops.ownCaptureSkipsIds) return [];
		const out: Rect[] = [];
		for (const e of this.windows) {
			if (e.excluded || !e.bounds) continue;
			const r = e.bounds();
			if (r && r.width > 0 && r.height > 0) out.push(r);
		}
		return out;
	}

	/**
	 * Register a native window Glimpse created without Electrobun (the Live frame, GLIM-90),
	 * whose helper already flagged it. Returns an unregister function.
	 */
	register(windowId: number): () => void {
		if (!(windowId > 0) || this.ids.has(windowId)) return () => {};
		this.ids.add(windowId);
		this.sink.setExcludedWindows(this.windowIds);
		return () => {
			if (this.ids.delete(windowId)) this.sink.setExcludedWindows(this.windowIds);
		};
	}

	/**
	 * Exclude `win` from capture (unless the setting is off and it isn't a surface), then run
	 * `show` (create windows with `hidden: true` and pass their show call here), then register
	 * the window's id with the capture source. Never throws: a failure is logged and the
	 * window is shown anyway.
	 */
	protect(win: ExcludableWindow, show?: () => void, options: ProtectOptions = {}): ProtectResult {
		const role = options.role ?? "surface";
		const handle = win.ptr;
		const flag = role === "surface" || this.hidden;
		let result: ProtectResult = { excluded: false, windowId: null, detail: "no exclusion on this platform" };
		if (this.ops && handle && flag) {
			try {
				result = this.ops.exclude(handle);
			} catch (e) {
				result = { excluded: false, windowId: null, detail: e instanceof Error ? e.message : String(e) };
			}
		} else if (this.ops && !handle) {
			result = { excluded: false, windowId: null, detail: "window has no native handle" };
		} else if (this.ops) {
			result = { excluded: false, windowId: null, detail: "shown to screen capture (setting off)" };
		}
		if (!result.excluded && this.ops && flag) this.log(`[capture] window not excluded from capture: ${result.detail}`);
		const entry: Entry = { handle, role, bounds: options.bounds, excluded: result.excluded };
		this.windows.add(entry);
		win.on("close", () => {
			this.windows.delete(entry);
		});
		show?.();

		let id = result.windowId;
		if (this.ops && handle && (id === null || id <= 0)) {
			try {
				id = this.ops.windowId(handle);
			} catch {
				id = null;
			}
		}
		if (id !== null && id > 0) {
			const windowId = id;
			this.ids.add(windowId);
			this.sink.setExcludedWindows(this.windowIds);
			win.on("close", () => {
				if (this.ids.delete(windowId)) this.sink.setExcludedWindows(this.windowIds);
			});
		}
		return { ...result, windowId: id };
	}
}
