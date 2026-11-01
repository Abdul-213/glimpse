// Keeps every Glimpse window out of screen capture (GLIM-36, from the GLIM-16 spike).
// Window controllers call `protect(win, show)` instead of showing a window directly:
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
// No electrobun import: a BrowserWindow satisfies ExcludableWindow structurally, and the
// OS calls come in as ExclusionOps, so this is unit-tested with fakes.
import type { Pointer } from "bun:ffi";

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
}

export interface ExclusionSink {
	setExcludedWindows(windowIds: readonly number[]): void;
}

export interface ProtectResult {
	readonly excluded: boolean;
	readonly windowId: number | null;
	readonly detail: string;
}

export class CaptureExclusion {
	private readonly ids = new Set<number>();

	constructor(
		private readonly ops: ExclusionOps | null,
		private readonly sink: ExclusionSink,
		private readonly log: (message: string) => void = () => {},
	) {}

	/** Currently registered native window ids. */
	get windowIds(): readonly number[] {
		return [...this.ids];
	}

	/**
	 * Exclude `win` from capture, then run `show` (create windows with `hidden: true` and
	 * pass their show call here), then register the window's id with the capture source.
	 * Never throws: a failure is logged and the window is shown anyway.
	 */
	protect(win: ExcludableWindow, show?: () => void): ProtectResult {
		const handle = win.ptr;
		let result: ProtectResult = { excluded: false, windowId: null, detail: "no exclusion on this platform" };
		if (this.ops && handle) {
			try {
				result = this.ops.exclude(handle);
			} catch (e) {
				result = { excluded: false, windowId: null, detail: e instanceof Error ? e.message : String(e) };
			}
		} else if (this.ops) {
			result = { excluded: false, windowId: null, detail: "window has no native handle" };
		}
		if (!result.excluded && this.ops) this.log(`[capture] window not excluded from capture: ${result.detail}`);
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
