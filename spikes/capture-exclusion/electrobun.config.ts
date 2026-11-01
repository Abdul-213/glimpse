import type { ElectrobunConfig } from "electrobun";

// GLIM-16 throwaway spike: OS-level capture exclusion for Glimpse's own windows.
//   Windows: SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE), called
//            straight from bun:ffi (user32 has no main-thread requirement for it).
//   macOS:   NSWindow.sharingType + ScreenCaptureKit SCContentFilter exclusion,
//            through a small Objective-C dylib (native/macos/glimcapture.m) that
//            hops to the main thread for AppKit, loaded with bun:ffi.
export default {
	app: {
		name: "Glimpse Capture Exclusion Spike",
		identifier: "dev.glimpse.spike.captureexclusion",
		version: "0.0.1",
	},
	runtime: {
		exitOnLastWindowClosed: true,
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		// Both windows use inline HTML (src/bun/html.ts), so no views bundle.
		// On macOS, ship the dylib built by `bun run native:mac` next to the
		// bundled main process (<Resources>/app/native/).
		copy:
			process.platform === "darwin"
				? { "native/macos/build/libglimcapture.dylib": "native/libglimcapture.dylib" }
				: {},
		mac: { bundleCEF: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
