// GLIM-45: the real ScreenAccessOS. macOS: preflight through libglimpse.dylib when it loaded
// (else Electrobun's own CoreGraphics binding), the request through Electrobun's
// `Utils.screenCapture.requestAccess` (a thin wrapper over CGRequestScreenCaptureAccess,
// spikes/capture/FINDINGS.md), System Settings through its URL scheme, and a relaunch helper
// that reopens the .app with `open`. Windows and Linux: no permission.
import { Utils } from "electrobun/main";
import type { Platform } from "../../shared/rpc.ts";
import { macBundleOf } from "./login-item.ts";
import { relaunchCommand, SCREEN_RECORDING_SETTINGS_URL, type ScreenAccessOS } from "./screen-access.ts";

export function screenAccessOS(
	platform: Platform,
	preflight: (() => boolean) | null,
	execPath: string = process.execPath,
): ScreenAccessOS {
	if (platform !== "macos") {
		return {
			required: false,
			canRestart: false,
			preflight: () => true,
			request: () => {},
			openSettings: () => false,
			scheduleRelaunch: () => false,
		};
	}
	const bundle = macBundleOf(execPath);
	return {
		required: true,
		canRestart: bundle !== null,
		preflight: preflight ?? (() => Utils.screenCapture.hasAccess()),
		request: () => {
			Utils.screenCapture.requestAccess();
		},
		openSettings: () => {
			if (Utils.openExternal(SCREEN_RECORDING_SETTINGS_URL)) return true;
			Utils.screenCapture.openSettings();
			return true;
		},
		scheduleRelaunch: () => {
			if (!bundle) return false;
			try {
				const child = Bun.spawn(relaunchCommand(bundle, process.pid), {
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				});
				child.unref();
				return true;
			} catch {
				return false;
			}
		},
	};
}
