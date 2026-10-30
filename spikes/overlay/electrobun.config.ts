import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "GlimpseOverlaySpike",
		identifier: "dev.glimpse.spike.overlay",
		version: "0.0.1",
	},
	runtime: {
		// Overlay windows close after every pick; the tray keeps the app alive.
		exitOnLastWindowClosed: false,
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		views: {
			overlay: {
				entrypoint: "src/overlay/index.ts",
			},
		},
		copy: {
			"src/overlay/index.html": "views/overlay/index.html",
			"src/overlay/index.css": "views/overlay/index.css",
		},
		mac: {
			bundleCEF: false,
			createDmg: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
