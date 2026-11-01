// Per-OS ExclusionOps for windows/capture-exclusion.ts.
import type { Pointer } from "bun:ffi";
import type { ExclusionOps } from "../windows/capture-exclusion.ts";
import { loadMacNative } from "./macos.ts";
import { setWindowExcludedFromCapture } from "./windows.ts";

const SHARING_NAMES = ["none", "readOnly", "readWrite"];

/** Null when the platform has nothing to exclude (Linux) or the macOS helper is missing. */
export function exclusionOpsFor(platform: string = process.platform): ExclusionOps | null {
	if (platform === "win32") {
		return {
			exclude(hwnd: Pointer) {
				const r = setWindowExcludedFromCapture(hwnd);
				const affinity = r.affinity === null ? "unreadable" : `0x${r.affinity.toString(16)}`;
				return {
					excluded: r.excluded,
					// The HWND value; WDA_EXCLUDEFROMCAPTURE needs no id list, it is informational.
					windowId: Number(hwnd),
					detail: r.excluded
						? "WDA_EXCLUDEFROMCAPTURE"
						: `display affinity reads back ${affinity} (needs Windows 10 2004 / build 19041+)`,
				};
			},
			windowId: (hwnd: Pointer) => Number(hwnd),
			setHidden(hwnd: Pointer, hidden: boolean) {
				const r = setWindowExcludedFromCapture(hwnd, hidden);
				return { excluded: r.excluded, detail: r.excluded ? "WDA_EXCLUDEFROMCAPTURE" : "WDA_NONE" };
			},
			// WDA_EXCLUDEFROMCAPTURE is the only thing keeping a window out of DXGI/GDI frames.
			ownCaptureSkipsIds: false,
		};
	}
	if (platform === "darwin") {
		const { binding } = loadMacNative();
		if (!binding) return null;
		return {
			exclude(nsWindow: Pointer) {
				const { windowNumber, sharingType } = binding.excludeWindowFromCapture(nsWindow);
				return {
					// Glimpse's own capture excludes the window through the SCK filter either way.
					excluded: sharingType === 0,
					windowId: windowNumber > 0 ? windowNumber : null,
					detail: `sharingType ${SHARING_NAMES[sharingType] ?? sharingType}`,
				};
			},
			windowId(nsWindow: Pointer) {
				const n = binding.windowNumber(nsWindow);
				return n > 0 ? n : null;
			},
			setHidden(nsWindow: Pointer, hidden: boolean) {
				const { sharingType } = binding.setWindowSharing(nsWindow, hidden);
				return { excluded: sharingType === 0, detail: `sharingType ${SHARING_NAMES[sharingType] ?? sharingType}` };
			},
			// The SCK filter skips registered window ids whatever sharingType says.
			ownCaptureSkipsIds: true,
		};
	}
	return null;
}
