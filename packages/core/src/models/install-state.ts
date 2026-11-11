// Install state for one downloadable artifact (an OCR recogniser, a Bergamot pack), as a pure
// reducer the app's model download manager drives (GLIM-38), plus the disk-space rule and the
// "can this route run now?" summary the UI shows.

/** Why an install failed. `network` while offline is the "offline" state the UI shows. */
export type InstallErrorKind =
	| "network" // fetch failed before a response: offline, DNS, TLS, connection reset
	| "http" // the server answered with an error status
	| "checksum" // bytes didn't match the manifest's SHA-256 (after every mirror)
	| "disk-full" // not enough free space, checked up front or ENOSPC while writing
	| "io" // any other filesystem error
	| "cancelled";

export interface InstallError {
	readonly kind: InstallErrorKind;
	readonly message: string;
}

/** Errors worth retrying without the user changing anything. */
export function isRetryable(error: InstallError): boolean {
	return error.kind === "network" || error.kind === "http";
}

export type InstallState =
	| { readonly status: "missing" }
	| { readonly status: "queued" }
	| { readonly status: "downloading"; readonly receivedBytes: number; readonly totalBytes: number }
	| { readonly status: "verifying" }
	| { readonly status: "installing" }
	| { readonly status: "installed"; readonly version: string; readonly bundled: boolean }
	| { readonly status: "failed"; readonly error: InstallError };

export type InstallEvent =
	| { readonly type: "queue" }
	| { readonly type: "progress"; readonly receivedBytes: number; readonly totalBytes: number }
	| { readonly type: "verify" }
	| { readonly type: "install" }
	| { readonly type: "done"; readonly version: string; readonly bundled?: boolean }
	| { readonly type: "fail"; readonly error: InstallError }
	| { readonly type: "remove" };

export const MISSING: InstallState = { status: "missing" };

const BUSY = new Set<InstallState["status"]>(["queued", "downloading", "verifying", "installing"]);

export function isBusy(state: InstallState): boolean {
	return BUSY.has(state.status);
}

/**
 * Next state. Transitions that make no sense (progress while idle, a second `queue` while
 * busy) leave the state unchanged, so a late event from a cancelled job can't resurrect it.
 */
export function installReducer(state: InstallState, event: InstallEvent): InstallState {
	switch (event.type) {
		case "queue":
			return isBusy(state) ? state : { status: "queued" };
		case "progress":
			if (state.status !== "queued" && state.status !== "downloading") return state;
			return {
				status: "downloading",
				receivedBytes: Math.max(0, Math.min(event.receivedBytes, event.totalBytes)),
				totalBytes: event.totalBytes,
			};
		case "verify":
			return state.status === "downloading" || state.status === "queued" ? { status: "verifying" } : state;
		case "install":
			return state.status === "verifying" ? { status: "installing" } : state;
		case "done":
			return { status: "installed", version: event.version, bundled: event.bundled ?? false };
		case "fail":
			return isBusy(state) ? { status: "failed", error: event.error } : state;
		case "remove":
			return isBusy(state) ? state : MISSING;
	}
}

/** 0..1 for a progress bar, or null when there is nothing to show. */
export function installProgress(state: InstallState): number | null {
	if (state.status === "downloading") return state.totalBytes > 0 ? state.receivedBytes / state.totalBytes : 0;
	if (state.status === "verifying" || state.status === "installing") return 1;
	return null;
}

/** Free space to keep beyond what an install needs. */
export const DISK_HEADROOM_BYTES = 64 * 1024 * 1024;

/**
 * Bytes an install needs free before it starts: every compressed download, plus every
 * unpacked file (both exist until the `.zst` is deleted), plus headroom. Bytes already
 * downloaded (resume) don't count again.
 */
export function requiredFreeBytes(
	files: readonly { readonly size: number; readonly decompressedSize?: number }[],
	alreadyDownloaded = 0,
): number {
	const download = files.reduce((n, f) => n + f.size, 0);
	const unpacked = files.reduce((n, f) => n + (f.decompressedSize ?? 0), 0);
	return Math.max(0, download - alreadyDownloaded) + unpacked + DISK_HEADROOM_BYTES;
}

/** What a feature (an OCR script, a translation route) can do with the models it needs. */
export type Availability =
	| { readonly kind: "ready" }
	| { readonly kind: "downloading"; readonly progress: number }
	/** Missing but downloadable now. `bytes` is the download size to show ("Download (31 MB)"). */
	| { readonly kind: "needs-download"; readonly ids: readonly string[]; readonly bytes: number }
	/** Missing and we're offline: show "not installed" and never fall through to the cloud. */
	| { readonly kind: "offline"; readonly ids: readonly string[] }
	| { readonly kind: "failed"; readonly ids: readonly string[]; readonly error: InstallError };

export interface NeededModel {
	readonly id: string;
	readonly state: InstallState;
	readonly downloadBytes: number;
}

export function summarizeAvailability(needed: readonly NeededModel[], online: boolean): Availability {
	const notReady = needed.filter((n) => n.state.status !== "installed");
	if (notReady.length === 0) return { kind: "ready" };
	const busy = notReady.filter((n) => isBusy(n.state));
	if (busy.length > 0) {
		const total = busy.reduce((s, n) => s + n.downloadBytes, 0);
		const done = busy.reduce((s, n) => s + (installProgress(n.state) ?? 0) * n.downloadBytes, 0);
		return { kind: "downloading", progress: total > 0 ? done / total : 0 };
	}
	const failed = notReady.find((n) => n.state.status === "failed");
	if (failed?.state.status === "failed" && !(failed.state.error.kind === "network" && !online)) {
		const ids = notReady.filter((n) => n.state.status === "failed").map((n) => n.id);
		return { kind: "failed", ids, error: failed.state.error };
	}
	const ids = notReady.map((n) => n.id);
	if (!online) return { kind: "offline", ids };
	return { kind: "needs-download", ids, bytes: notReady.reduce((s, n) => s + n.downloadBytes, 0) };
}
