// Picks and builds the CaptureSource for this run. No electrobun import: the shell's
// display list is passed in, so the Linux harness and tests can use this module.
//
//   Windows  WindowsCaptureSource (glimpse.dll: DXGI for Live, GDI for Snip)
//   macOS    MacCaptureSource (libglimpse.dylib: ScreenCaptureKit)
//   Linux    none yet: the file-based backend for the headless harness is GLIM-86
//
// Environment:
//   GLIMPSE_CAPTURE=native   the default on Windows/macOS (more choices arrive with GLIM-86)
import type { CaptureSource, Display } from "@glimpse/core";
import { loadMacNative } from "../../native/macos.ts";
import { loadWindowsCapture } from "../../native/windows.ts";
import { MacCaptureSource } from "./macos.ts";
import { UnavailableCaptureSource } from "./unavailable.ts";
import { WindowsCaptureSource } from "./windows.ts";

export type CaptureChoice =
	| { readonly kind: "windows" }
	| { readonly kind: "macos" }
	| { readonly kind: "none"; readonly reason: string };

/** Pure backend choice from platform + environment. */
export function chooseCaptureBackend(platform: string, env: Record<string, string | undefined>): CaptureChoice {
	const forced = env["GLIMPSE_CAPTURE"]?.trim().toLowerCase();
	if (forced && forced !== "native") {
		return { kind: "none", reason: `GLIMPSE_CAPTURE must be "native", got "${forced}"` };
	}
	if (platform === "win32") return { kind: "windows" };
	if (platform === "darwin") return { kind: "macos" };
	return { kind: "none", reason: `no capture backend on ${platform}` };
}

export interface CaptureSetup {
	readonly source: CaptureSource;
	readonly choice: CaptureChoice;
	/** Human-readable status for diagnostics and the startup log. */
	readonly status: string;
}

export interface CreateCaptureOptions {
	readonly platform?: string;
	readonly env?: Record<string, string | undefined>;
	/** Logical displays from the shell (Electrobun Screen). */
	readonly shellDisplays?: () => readonly Display[];
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

/** Build the capture source. Never throws: failures give an UnavailableCaptureSource. */
export function createCaptureSource(options: CreateCaptureOptions = {}): CaptureSetup {
	const platform = options.platform ?? process.platform;
	const choice = chooseCaptureBackend(platform, options.env ?? process.env);
	const shellDisplays = options.shellDisplays ?? (() => []);
	const log = options.log ?? (() => {});
	const now = options.now ?? Date.now;
	const unavailable = (reason: string): CaptureSetup => ({
		source: new UnavailableCaptureSource(reason, shellDisplays),
		choice,
		status: `unavailable: ${reason}`,
	});

	switch (choice.kind) {
		case "none":
			return unavailable(choice.reason);
		case "windows": {
			const { status, binding } = loadWindowsCapture();
			if (!binding) return unavailable(status.available ? "glimpse.dll failed to load" : status.reason);
			const source = new WindowsCaptureSource({
				binding,
				shellDisplays,
				now,
				onFallback: (id, e) => log(`[capture] display ${id}: DXGI unavailable, using GDI (${e.message})`),
			});
			return { source, choice, status: `${source.backend} (${status.available ? status.path : ""})` };
		}
		case "macos": {
			const { status, binding } = loadMacNative();
			if (!binding) return unavailable(status.available ? "libglimpse.dylib failed to load" : status.reason);
			const source = new MacCaptureSource({
				binding,
				shellDisplays,
				now,
				onExclusionError: (e) => log(`[capture] exclusion list update failed: ${String(e)}`),
			});
			const permission = binding.preflight() ? "screen recording granted" : "screen recording not granted yet";
			return {
				source,
				choice,
				status: `${source.backend} (${status.available ? status.path : ""}; ${permission})`,
			};
		}
	}
}
