import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json" with { type: "json" };

// Webviews are built by scripts/build-views.ts (Bun bundler + Solid + Tailwind) into
// dist/views/<name>/, which runs here as the preBuild hook; `copy` then places them in
// the app, where windows load views://<name>/index.html.
//
// Native helpers (ARCHITECTURE.md "Native helpers") are copied next to the main bundle
// as native/<file>, only on their own OS, e.g.
//   ...(process.platform === "darwin" ? { "native/macos/build/libglimpse.dylib": "native/libglimpse.dylib" } : {}),
export default {
	app: {
		name: "Glimpse",
		identifier: "dev.glimpse.app",
		version: pkg.version,
		description: pkg.description,
	},
	runtime: {
		// Tray app: closing Settings must not quit.
		exitOnLastWindowClosed: false,
	},
	scripts: {
		preBuild: "scripts/prebuild.ts",
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		copy: {
			"dist/views": "views",
			"assets/tray": "views/assets",
		},
		watch: ["src/views", "../packages/ui/src", "../packages/core/src"],
		watchIgnore: ["dist/**"],
		mac: { bundleCEF: false, createDmg: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
