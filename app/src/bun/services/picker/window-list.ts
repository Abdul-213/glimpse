// WindowListSource implementations over the native helpers (GLIM-91, region-picker spec 9.3).
// No electrobun import: the shell's displays come in as a function, so this is tested on
// Linux with fake bindings.
import {
	type Display,
	nativeToLogicalRect,
	type ScreenWindow,
	type WindowListSource,
	withNativeBounds,
} from "@glimpse/core";
import type { MacPickerBinding } from "../../native/macos.ts";
import type { NativeWindowInfo } from "../../native/window-info.ts";
import type { PhysicalDisplay, WindowsPickerBinding } from "../../native/windows.ts";

/** Windows smaller than this (logical px, either side) are never snap targets (spec 4). */
export const MIN_WINDOW_SIZE = 40;

const big = (w: ScreenWindow) => w.rect.width >= MIN_WINDOW_SIZE && w.rect.height >= MIN_WINDOW_SIZE;
const byZ = (a: ScreenWindow, b: ScreenWindow) => a.z - b.z;

/** macOS: CoreGraphics bounds are already global points, Electrobun's logical space. */
export function macWindows(native: readonly NativeWindowInfo[]): ScreenWindow[] {
	return native
		.map((w) => ({ rect: w.rect, pid: w.pid, z: w.z, appName: w.appName }))
		.filter(big)
		.sort(byZ);
}

/**
 * Windows: DWM frame bounds are physical px. Map each through the monitors it lies on
 * (glimpse.dll's physical rects joined to Electrobun's logical ones by HMONITOR).
 * Windows on no known monitor are dropped.
 */
export function windowsWindows(
	native: readonly NativeWindowInfo[],
	shell: readonly Display[],
	physical: readonly PhysicalDisplay[],
): ScreenWindow[] {
	const displays = withNativeBounds(shell, physical);
	const out: ScreenWindow[] = [];
	for (const w of native) {
		const rect = nativeToLogicalRect(displays, w.rect);
		if (rect) out.push({ rect, pid: w.pid, z: w.z, appName: w.appName });
	}
	return out.filter(big).sort(byZ);
}

export class MacWindowList implements WindowListSource {
	constructor(private readonly binding: MacPickerBinding) {}

	async list(): Promise<readonly ScreenWindow[]> {
		return macWindows(this.binding.listWindows());
	}
}

export class WindowsWindowList implements WindowListSource {
	constructor(
		private readonly binding: WindowsPickerBinding & { physicalDisplays(): PhysicalDisplay[] },
		private readonly shellDisplays: () => readonly Display[],
	) {}

	async list(): Promise<readonly ScreenWindow[]> {
		return windowsWindows(this.binding.listWindows(), this.shellDisplays(), this.binding.physicalDisplays());
	}
}

/** No helper (Linux, or the helper failed to load): no window snapping. */
export class EmptyWindowList implements WindowListSource {
	async list(): Promise<readonly ScreenWindow[]> {
		return [];
	}
}
