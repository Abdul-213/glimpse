import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json" with { type: "json" };

// Webviews are built by scripts/build-views.ts (Bun bundler + Solid + Tailwind) into
// dist/views/<name>/, which runs here as the preBuild hook; `copy` then places them in
// the app, where windows load views://<name>/index.html.
//
// Native helpers (ARCHITECTURE.md "Native helpers") are copied next to the main bundle
// as native/<file>, only on their own OS and only once built (app/native/<os>/build.sh or
// build.ps1). Without one the app still builds and starts, and capture reports
// "unavailable"; scripts/prebuild.ts prints a warning.
export const NATIVE_LIBS = {
	darwin: { from: "native/macos/build/libglimpse.dylib", to: "native/libglimpse.dylib" },
	win32: { from: "native/windows/build/glimpse.dll", to: "native/glimpse.dll" },
} as const;

export function nativeCopy(platform: string, exists: (path: string) => boolean): Record<string, string> {
	const lib = platform === "darwin" || platform === "win32" ? NATIVE_LIBS[platform] : null;
	return lib && exists(lib.from) ? { [lib.from]: lib.to } : {};
}

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
		// macOS: LSUIElement in the app's and the wrapper's Info.plist (GLIM-106, scripts/mac-accessory.ts).
		postBuild: "scripts/postbuild.ts",
		postWrap: "scripts/postbuild.ts",
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		copy: {
			"dist/views": "views",
			// Inference Workers (GLIM-101, GLIM-103), bundled by the preBuild hook; found next to bun/index.js.
			"dist/workers/bergamot-worker.js": "bun/bergamot-worker.js",
			"dist/workers/ocr-worker.js": "bun/ocr-worker.js",
			"dist/workers/small100-worker.js": "bun/small100-worker.js",
			// onnxruntime-node's native binding + runtime for this OS/arch only, CPU provider only
			// (GLIM-103, scripts/onnxruntime.ts). The OCR Worker loads it from ../native/onnxruntime/.
			"dist/onnxruntime": "native/onnxruntime",
			"assets/tray": "views/assets",
			// fastText's WASM runtime (GLIM-104), staged by the preBuild hook; found next to bun/index.js.
			"dist/fasttext/fastText.node.wasm": "bun/fastText.node.wasm",
			// Bundled models + NOTICE (GLIM-37), staged by the preBuild hook from app/models/manifest.json.
			"dist/models": "models",
			...nativeCopy(process.platform, (p) => existsSync(resolve(import.meta.dir, p))),
		},
		watch: ["src/views", "../packages/ui/src", "../packages/core/src"],
		watchIgnore: ["dist/**"],
		mac: { bundleCEF: false, createDmg: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
