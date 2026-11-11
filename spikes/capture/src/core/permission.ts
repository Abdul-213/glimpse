// macOS Screen Recording permission state, derived from what the public APIs
// actually expose. There is no public "read TCC state" API:
//   CGPreflightScreenCaptureAccess() -> bool   (granted for *this process* or not;
//                                               the answer is cached for the life of
//                                               the process)
//   CGRequestScreenCaptureAccess()   -> bool   (shows the system prompt only the first
//                                               time, i.e. when not yet determined;
//                                               afterwards returns false silently)
//   ScreenCaptureKit errors                    (SCStreamError.userDeclined = -3801)
// So "denied" vs "not determined" can only be told apart by remembering whether
// we have asked before. Glimpse would persist that flag in its settings.

export type PermissionState =
	| "granted"
	| "not-determined"
	| "denied-or-restart-needed"
	| "granted-but-capture-failing";

export interface PermissionInputs {
	preflight: boolean;
	/** Persisted: have we ever called CGRequestScreenCaptureAccess / triggered SCK? */
	everRequested: boolean;
	/** Result of a ScreenCaptureKit probe (SCShareableContent), if one was run. */
	sckProbe?: { ok: true } | { ok: false; code: number; message: string };
}

export interface PermissionVerdict {
	state: PermissionState;
	explanation: string;
}

export const SCK_USER_DECLINED = -3801;

export function derivePermission(i: PermissionInputs): PermissionVerdict {
	if (i.preflight) {
		if (i.sckProbe && !i.sckProbe.ok) {
			return {
				state: "granted-but-capture-failing",
				explanation:
					`Preflight says granted but ScreenCaptureKit failed (${i.sckProbe.code}: ${i.sckProbe.message}). ` +
					"Typical after the toggle was switched off while the app was running (preflight is cached per process).",
			};
		}
		return { state: "granted", explanation: "CGPreflightScreenCaptureAccess() returned true." };
	}
	if (!i.everRequested) {
		return {
			state: "not-determined",
			explanation:
				"Preflight is false and this app has never asked. Requesting will show the system prompt " +
				"(unless TCC already holds a deny/allow for a *different* code signature of this bundle id).",
		};
	}
	return {
		state: "denied-or-restart-needed",
		explanation:
			"Preflight is false and we asked before. Either the user denied it, the grant belongs to a " +
			"different code signature (rebuild of an ad-hoc signed app), or it was just granted and the app " +
			"must be relaunched. No public API distinguishes these; send the user to System Settings and offer Quit & Reopen.",
	};
}
