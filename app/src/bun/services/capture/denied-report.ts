// GLIM-121: a capture that fails with `permission-denied` means macOS Screen Recording was
// switched off (or lost after an update) while Glimpse runs; the cached preflight still says
// yes. Snip and Live capture through this wrapper, which tells ScreenAccess
// (`reportCaptureDenied`, GLIM-45) so the tray notice and the screen-access window appear
// instead of a generic error. The error itself still reaches the caller unchanged (the
// Snip popup shows E-kind copy, the Live loop pauses on it).
//
// Pure delegation over the core CaptureSource port; tested on Linux with a fake source.
import { CaptureError, type CaptureSession, type CaptureSource } from "@glimpse/core";

function check(error: unknown, onDenied: () => void): never {
	if (error instanceof CaptureError && error.code === "permission-denied") {
		try {
			onDenied();
		} catch {
			// Reporting is best effort; the capture error is what the caller needs.
		}
	}
	throw error;
}

function watchSession(session: CaptureSession, onDenied: () => void): CaptureSession {
	return {
		rect: session.rect,
		next: () => session.next().catch((e: unknown) => check(e, onDenied)),
		close: () => session.close(),
	};
}

/** `source`, but every `permission-denied` from a capture, a session open or a frame calls `onDenied`. */
export function withDeniedReport(source: CaptureSource, onDenied: () => void): CaptureSource {
	return {
		get backend() {
			return source.backend;
		},
		get exclusion() {
			return source.exclusion;
		},
		displays: () => source.displays(),
		capture: (rect, options) => source.capture(rect, options).catch((e: unknown) => check(e, onDenied)),
		openSession: (rect, options) =>
			source.openSession(rect, options).then(
				(session) => watchSession(session, onDenied),
				(e: unknown) => check(e, onDenied),
			),
		setExcludedWindows: (ids) => source.setExcludedWindows(ids),
		dispose: () => source.dispose(),
	};
}
