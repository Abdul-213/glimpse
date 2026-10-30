import type { ElectrobunConfig } from "electrobun";

// GLIM-14 throwaway spike: global hotkey registration.
// One app, two hotkey backends picked at runtime (see src/bun/index.ts):
//   electrobun - Electrobun's built-in GlobalShortcut (RegisterHotKey on Windows,
//                NSEvent global monitor on macOS)
//   carbon     - macOS only: Carbon RegisterEventHotKey via a tiny dylib loaded
//                with bun:ffi (native/macos/glimhotkey.c)
export default {
	app: {
		name: "Glimpse Hotkey Spike",
		identifier: "dev.glimpse.spike.hotkeys",
		version: "0.0.1",
	},
	runtime: {
		// Tray-style app: keep running when the counter window is closed.
		exitOnLastWindowClosed: false,
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		// The counter window uses inline HTML (src/bun/window-html.ts), so no views.
		// On macOS, ship the Carbon dylib built by `bun run native:mac` next to
		// the bundled main process (<Resources>/app/native/).
		copy:
			process.platform === "darwin"
				? { "native/macos/build/libglimhotkey.dylib": "native/libglimhotkey.dylib" }
				: {},
		mac: { bundleCEF: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
