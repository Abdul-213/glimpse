// Picks and builds the CaptureSource for this run. No electrobun import: the shell's
// display list is passed in, so the Linux harness and tests can use this module.
//
//   Windows  WindowsCaptureSource (glimpse.dll: DXGI for Live, GDI for Snip)
//   macOS    MacCaptureSource (libglimpse.dylib: ScreenCaptureKit)
//   Linux    file-based source over a frame folder (GLIM-86)
//
// Environment:
//   GLIMPSE_CAPTURE=native|file   force a backend (default: native on Windows/macOS, file elsewhere)
//   GLIMPSE_CAPTURE_FRAMES=<path> frame folder or PNG for the file backend; setting it
//                                 selects the file backend unless GLIMPSE_CAPTURE=native.
//                                 Default: the sample frames in app/test/fixtures/capture/sample
import { resolve } from "node:path";
import type { CaptureSource, Display } from "@glimpse/core";
import { loadMacNative } from "../../native/macos.ts";
import { loadWindowsCapture } from "../../native/windows.ts";
import { createFileCaptureSource } from "./file.ts";
import { MacCaptureSource } from "./macos.ts";
import { UnavailableCaptureSource } from "./unavailable.ts";
import { WindowsCaptureSource } from "./windows.ts";

/** The committed sample sequence (exists in the source tree, not in a packaged app). */
export const SAMPLE_FRAMES_DIR = resolve(import.meta.dir, "../../../../test/fixtures/capture/sample");

export type CaptureChoice =
	| { readonly kind: "windows" }
	| { readonly kind: "macos" }
	| { readonly kind: "file"; readonly path: string }
	| { readonly kind: "none"; readonly reason: string };

/** Pure backend choice from platform + environment. */
export function chooseCaptureBackend(platform: string, env: Record<string, string | undefined>): CaptureChoice {
	const forced = env["GLIMPSE_CAPTURE"]?.trim().toLowerCase();
	const frames = env["GLIMPSE_CAPTURE_FRAMES"]?.trim();
	if (forced && forced !== "native" && forced !== "file") {
		return { kind: "none", reason: `GLIMPSE_CAPTURE must be "native" or "file", got "${forced}"` };
	}
	const native = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : null;
	if (forced === "native" || (forced !== "file" && !frames && native)) {
		return native ? { kind: native } : { kind: "none", reason: `no native capture backend on ${platform}` };
	}
	return { kind: "file", path: frames ? resolve(frames) : SAMPLE_FRAMES_DIR };
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
	/** Logical displays from the shell (Electrobun Screen); unused by the file backend. */
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
		case "file":
			try {
				const source = createFileCaptureSource(choice.path, { now });
				return { source, choice, status: `file: ${choice.path} (${source.frameCount} frames)` };
			} catch (e) {
				return unavailable(e instanceof Error ? e.message : String(e));
			}
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
