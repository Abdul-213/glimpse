// Builds the region picker's OS ports for this run (GLIM-91). No electrobun import:
// displays come in as a function, so the harness and tests use this module.
//
//   Windows  window list + focus from glimpse.dll; loupe = GDI one-shots via the capture source
//   macOS    window list + focus from libglimpse.dylib; loupe = a warm SCStream (mac-sampler.ts)
//   other    no window list, no focus handling; loupe = the capture source (file backend)
import {
	CapturePixelSampler,
	type CaptureSource,
	type Display,
	type FocusKeeper,
	type PixelSampler,
	type WindowListSource,
} from "@glimpse/core";
import { loadMacNative } from "../../native/macos.ts";
import { loadWindowsCapture } from "../../native/windows.ts";
import { NativeFocusKeeper, NoFocusKeeper } from "./focus.ts";
import { MacStreamPixelSampler } from "./mac-sampler.ts";
import { EmptyWindowList, MacWindowList, WindowsWindowList } from "./window-list.ts";

export interface PickerNatives {
	readonly windows: WindowListSource;
	readonly sampler: PixelSampler;
	readonly focus: FocusKeeper;
	/** For diagnostics and the startup log. */
	readonly status: string;
}

export interface PickerNativesOptions {
	readonly platform?: string;
	/** The app's capture source (loupe pixels come from capture, never from the webview). */
	readonly capture: CaptureSource;
	readonly shellDisplays: () => readonly Display[];
	readonly log?: (message: string) => void;
	/** Use native helpers. Default: true unless the capture source is the file backend. */
	readonly native?: boolean;
}

export function createPickerNatives(options: PickerNativesOptions): PickerNatives {
	const platform = options.platform ?? process.platform;
	const log = options.log ?? (() => {});
	const reportOnce = (what: string) => (e: unknown) =>
		log(`[picker] ${what}: ${e instanceof Error ? e.message : String(e)}`);
	const captureSampler = new CapturePixelSampler(options.capture, reportOnce("loupe capture failed"));
	const native = options.native ?? options.capture.backend !== "file";
	const fallback = (reason: string): PickerNatives => ({
		windows: new EmptyWindowList(),
		sampler: captureSampler,
		focus: new NoFocusKeeper(),
		status: `no native picker helpers (${reason}); loupe from ${options.capture.backend}`,
	});
	if (!native) return fallback(`capture backend is ${options.capture.backend}`);

	if (platform === "win32") {
		const { status, binding } = loadWindowsCapture();
		if (!binding) return fallback(status.available ? "glimpse.dll failed to load" : status.reason);
		return {
			windows: new WindowsWindowList(binding, options.shellDisplays),
			sampler: captureSampler,
			focus: new NativeFocusKeeper(binding, log),
			status: "glimpse.dll window list + focus; loupe from GDI",
		};
	}
	if (platform === "darwin") {
		const { status, binding } = loadMacNative();
		if (!binding) return fallback(status.available ? "libglimpse.dylib failed to load" : status.reason);
		return {
			windows: new MacWindowList(binding),
			sampler: new MacStreamPixelSampler(
				binding,
				options.shellDisplays,
				captureSampler,
				reportOnce("loupe stream failed, using screenshots"),
			),
			focus: new NativeFocusKeeper(binding, log),
			status: "libglimpse.dylib window list + focus; loupe from an SCStream",
		};
	}
	return fallback(`no helper on ${platform}`);
}
