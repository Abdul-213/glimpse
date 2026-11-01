// Status codes returned by glim_* functions and how they map to CaptureError codes.
// Pure (no FFI) so the mapping is tested on Linux.
//
// Convention (ARCHITECTURE.md section 6): 0 = ok. Small negatives (-1..-99) are
// Glimpse's own codes, shared by both helpers (see app/native/*/glimpse.h). Anything
// else is the OS's status: an HRESULT on Windows, an NSError / OSStatus code on macOS.
import { CaptureError, type CaptureErrorCode } from "@glimpse/core";

export const GLIM_OK = 0;
export const GLIM_E_ARGS = -1;
export const GLIM_E_NO_DISPLAY = -2;
export const GLIM_E_UNSUPPORTED = -3;
export const GLIM_E_API = -4;
export const GLIM_E_NO_FRAME = -5;
export const GLIM_E_BACKEND = -6;
export const GLIM_E_TIMEOUT = -7;
export const GLIM_E_PERMISSION = -8;
export const GLIM_E_NOT_A_WINDOW = -9;

const OWN: Record<number, [CaptureErrorCode, string]> = {
	[GLIM_E_ARGS]: ["invalid-argument", "bad arguments"],
	[GLIM_E_NO_DISPLAY]: ["no-display", "display not found"],
	[GLIM_E_UNSUPPORTED]: ["unavailable", "not supported on this OS version or setup"],
	[GLIM_E_API]: ["failed", "OS call failed"],
	[GLIM_E_NO_FRAME]: ["temporarily-unavailable", "no frame available yet"],
	[GLIM_E_BACKEND]: ["invalid-argument", "unknown backend"],
	[GLIM_E_TIMEOUT]: ["timeout", "timed out"],
	[GLIM_E_PERMISSION]: ["permission-denied", "screen capture permission not granted"],
	[GLIM_E_NOT_A_WINDOW]: ["invalid-argument", "not a window"],
};

/** Windows HRESULTs worth naming (as signed int32, the way bun:ffi returns them). */
const HRESULTS: Record<number, [CaptureErrorCode, string]> = {
	[0x80070005 | 0]: ["temporarily-unavailable", "E_ACCESSDENIED (secure desktop: UAC prompt or lock screen)"],
	[0x887a0026 | 0]: ["temporarily-unavailable", "DXGI_ERROR_ACCESS_LOST (mode change or fullscreen switch)"],
	[0x887a0022 | 0]: ["temporarily-unavailable", "DXGI_ERROR_NOT_CURRENTLY_AVAILABLE (too many duplications)"],
	[0x887a0028 | 0]: ["temporarily-unavailable", "DXGI_ERROR_SESSION_DISCONNECTED (remote session)"],
	[0x887a0004 | 0]: ["unavailable", "DXGI_ERROR_UNSUPPORTED (wrong adapter, remote session or basic display driver)"],
	[0x887a0027 | 0]: ["temporarily-unavailable", "DXGI_ERROR_WAIT_TIMEOUT"],
};

/** ScreenCaptureKit SCStreamErrorCode values. */
const SCK: Record<number, [CaptureErrorCode, string]> = {
	[-3801]: ["permission-denied", "SCStreamErrorUserDeclined (Screen Recording not granted)"],
	[-3803]: ["permission-denied", "SCStreamErrorMissingEntitlements"],
	[-3802]: ["failed", "SCStreamErrorFailedToStart"],
	[-3805]: ["invalid-argument", "SCStreamErrorInvalidParameter"],
	[-3808]: ["temporarily-unavailable", "SCStreamErrorNoCaptureSource"],
	[-3815]: ["no-display", "SCStreamErrorNoDisplayList"],
	[-3817]: ["temporarily-unavailable", "SCStreamErrorUserStopped"],
};

export type NativeOsName = "windows" | "macos";

export function describeStatus(os: NativeOsName, status: number): { code: CaptureErrorCode; text: string } {
	const own = OWN[status];
	if (own) return { code: own[0], text: own[1] };
	const table = os === "windows" ? HRESULTS : SCK;
	const known = table[status];
	if (known) return { code: known[0], text: known[1] };
	const shown = os === "windows" ? `0x${(status >>> 0).toString(16).padStart(8, "0")}` : String(status);
	return { code: "failed", text: `status ${shown}` };
}

/** Build the CaptureError for a failed glim_* call. `detail` is glim_last_error(). */
export function captureErrorFor(os: NativeOsName, what: string, status: number, detail: string): CaptureError {
	const { code, text } = describeStatus(os, status);
	return new CaptureError(code, `${what} failed: ${text}${detail ? ` (${detail})` : ""}`, status);
}
