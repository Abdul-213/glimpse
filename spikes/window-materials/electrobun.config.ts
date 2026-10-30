import type { ElectrobunConfig } from "electrobun";

// GLIM-19 throwaway spike: a frameless, rounded popup with a native material
// behind a transparent webview, plus a normal control window.
//   macOS:   NSVisualEffectView (or NSGlassEffectView on macOS 26) inserted
//            behind the WKWebView by native/macos/glimmaterial.m, loaded with bun:ffi.
//   Windows: DWM attributes (system backdrop, corner preference, extended frame)
//            called straight from bun:ffi on BrowserWindow.ptr (the HWND).
export default {
	app: {
		name: "GlimpseMaterialsSpike",
		identifier: "dev.glimpse.spike.materials",
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
		views: {
			popup: { entrypoint: "src/popup/index.ts" },
			control: { entrypoint: "src/control/index.ts" },
		},
		copy: {
			"src/popup/index.html": "views/popup/index.html",
			"src/popup/index.css": "views/popup/index.css",
			"src/control/index.html": "views/control/index.html",
			"src/control/index.css": "views/control/index.css",
			...(process.platform === "darwin"
				? { "native/macos/build/libglimmaterial.dylib": "native/libglimmaterial.dylib" }
				: {}),
		},
		mac: { bundleCEF: false, createDmg: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
