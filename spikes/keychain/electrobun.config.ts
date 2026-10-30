import type { ElectrobunConfig } from "electrobun";

// GLIM-18 throwaway spike: OS secret store access from an Electrobun app.
// The Bun main process calls Bun.secrets (Keychain Services on macOS,
// Credential Manager on Windows, libsecret on Linux). No native code is built.
export default {
	app: {
		name: "Glimpse Keychain Spike",
		identifier: "dev.glimpse.spike.keychain",
		version: "0.0.1",
	},
	runtime: {
		exitOnLastWindowClosed: false,
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		mac: { bundleCEF: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
