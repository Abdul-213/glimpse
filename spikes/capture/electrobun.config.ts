import type { ElectrobunConfig } from "electrobun";

// Copy only the native library for the OS being built; a missing library fails
// the build loudly (build it first: see TESTING.md). Linux builds carry none.
const nativeCopy: Record<string, string> =
	process.platform === "darwin"
		? { "native/macos/build/libglimcapture.dylib": "native/libglimcapture.dylib" }
		: process.platform === "win32"
			? { "native/windows/build/glimcapture.dll": "native/glimcapture.dll" }
			: {};

// GLIM-15 throwaway spike: region screen capture into a raw RGBA buffer.
// The Bun main process loads a small per-OS native library with bun:ffi:
//   macOS   - native/macos/build/libglimcapture.dylib (Swift: ScreenCaptureKit)
//   Windows - native/windows/build/glimcapture.dll    (C++: GDI, DXGI dup, WGC)
// Build the library first (see TESTING.md); it is copied into the bundle here.
// The window uses inline HTML (src/bun/window-html.ts), so there is no view bundle.
export default {
	app: {
		name: "Glimpse Capture Spike",
		// TCC keys Screen Recording grants on this bundle id + the code signature.
		identifier: "dev.glimpse.spike.capture",
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
		copy: nativeCopy,
		mac: { bundleCEF: false, createDmg: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
