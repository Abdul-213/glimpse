// GLIM-45: screen-capture permission state (macOS Screen Recording), derived from what the
// public APIs expose (spikes/capture/FINDINGS.md "macOS Screen Recording permission"):
//
//   CGPreflightScreenCaptureAccess()  granted for *this process*, never prompts. Effectively
//                                     fixed for the life of the process, so a grant usually
//                                     needs a relaunch.
//   CGRequestScreenCaptureAccess()    shows the system prompt only while not determined;
//                                     afterwards returns false silently.
//
// No public API tells "denied" from "not determined", so the app remembers what happened
// before (`ScreenAccessMemory`, persisted in settings) and this module turns that plus the
// preflight answer into a state the UI can explain:
//
//   not-needed      the OS has no such permission (Windows)
//   granted         capture works
//   not-determined  never asked: asking shows the system prompt
//   denied          asked before and not granted. Either the user said no, or they just
//                   turned it on and Glimpse needs a restart to see it.
//   lost            Glimpse had access before and now doesn't. On an unsigned (ad-hoc signed)
//                   build this happens after every update, because macOS ties the grant to
//                   the code signature, which changes with each build; System Settings may
//                   still show the switch on (a stale entry). Also after a manual revoke.
//
// Pure: no platform checks. The app passes `required` (macOS) and the preflight result.

/** What Glimpse remembers between runs. `unknown` = never asked. */
export type ScreenAccessMemory = "unknown" | "requested" | "granted";

export const SCREEN_ACCESS_MEMORY: readonly ScreenAccessMemory[] = ["unknown", "requested", "granted"];

export type ScreenAccessState = "not-needed" | "granted" | "not-determined" | "denied" | "lost";

export interface ScreenAccessInputs {
	/** Does this OS gate screen capture behind a permission? (macOS yes, Windows no.) */
	readonly required: boolean;
	/** CGPreflightScreenCaptureAccess() for this process. */
	readonly preflight: boolean;
	readonly memory: ScreenAccessMemory;
	/** A capture failed with `permission-denied` in this process (revoked while running). */
	readonly captureDenied?: boolean;
}

export function deriveScreenAccess(i: ScreenAccessInputs): ScreenAccessState {
	if (!i.required) return "not-needed";
	if (i.preflight && !i.captureDenied) return "granted";
	// Preflight still says yes but capture is refused: switched off while Glimpse was running.
	if (i.preflight) return "lost";
	switch (i.memory) {
		case "unknown":
			return "not-determined";
		case "requested":
			return "denied";
		case "granted":
			return "lost";
	}
}

/** The memory to persist after observing `state` (and possibly asking). */
export function nextScreenAccessMemory(
	memory: ScreenAccessMemory,
	observed: { readonly granted: boolean; readonly requested?: boolean },
): ScreenAccessMemory {
	if (observed.granted) return "granted";
	if (memory === "unknown" && observed.requested) return "requested";
	return memory;
}

/** Can Snip and Live capture other apps' windows right now? */
export const canCapture = (state: ScreenAccessState): boolean => state === "granted" || state === "not-needed";
