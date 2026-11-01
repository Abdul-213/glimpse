// onnxruntime-node in the built app (GLIM-103). The npm package ships every platform's native
// binaries (~260 MB) under bin/napi-v6/<os>/<arch>/; the app needs only the target's, and only
// what the CPU execution provider loads:
//
//   linux  x64/arm64  onnxruntime_binding.node + libonnxruntime.so.1      (RUNPATH $ORIGIN)
//   darwin arm64      onnxruntime_binding.node + libonnxruntime.1.dylib   (@rpath, @loader_path)
//   win32  x64/arm64  onnxruntime_binding.node + onnxruntime.dll
//
// Left out on purpose:
// - darwin libonnxruntime.1.31.1.dylib: a byte-identical copy (npm has no symlinks); the
//   binding links @rpath/libonnxruntime.1.dylib.
// - win32 DirectML.dll + dxcompiler.dll (36 MB): onnxruntime.dll only delay-loads DirectML.dll
//   (with d3d12/dxgi) when the DirectML provider is used, and dxcompiler.dll is LoadLibrary'd
//   by the WebGPU provider. Checked from the PE import tables of 1.31.1; we only use CPU.
// - darwin x64: onnxruntime-node >= 1.24 ships no Intel Mac build (GLIM-89). The build
//   still succeeds; the app reports local OCR as unavailable there.
//
// The preBuild hook stages the files into dist/onnxruntime/; electrobun.config.ts copies that to
// <app>/native/onnxruntime/, and the bundled OCR Worker (<app>/bun/ocr-worker.js) loads the
// binding from ../native/onnxruntime/ (see ortBindingPlugin in build-workers.ts).
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ORT_BINDING = "onnxruntime_binding.node";
export const ortOut = resolve(import.meta.dir, "..", "dist", "onnxruntime");

const LIBS: Readonly<Record<string, readonly string[]>> = {
	"linux-x64": ["libonnxruntime.so.1"],
	"linux-arm64": ["libonnxruntime.so.1"],
	"darwin-arm64": ["libonnxruntime.1.dylib"],
	"win32-x64": ["onnxruntime.dll"],
	"win32-arm64": ["onnxruntime.dll"],
};

/** Files to ship for a target, binding first, or null when onnxruntime-node has no build for it. */
export function ortFilesFor(os: string, arch: string): readonly string[] | null {
	const libs = LIBS[`${os}-${arch}`];
	return libs ? [ORT_BINDING, ...libs] : null;
}

/** onnxruntime-node's bin/napi-v6 folder (resolved from @glimpse/providers, which depends on it). */
export function ortBinDir(): string {
	const providers = dirname(fileURLToPath(import.meta.resolve("@glimpse/providers")));
	const pkg = Bun.resolveSync("onnxruntime-node/package.json", providers);
	return join(dirname(pkg), "bin", "napi-v6");
}

/**
 * The build target. Electrobun builds for the host (no cross-compiling), so the host's
 * platform/arch; `GLIMPSE_ORT_TARGET=<os>-<arch>` overrides it (tests, packaging checks).
 */
export function ortTarget(env: Record<string, string | undefined> = process.env): { os: string; arch: string } {
	const forced = env["GLIMPSE_ORT_TARGET"];
	if (forced) {
		const [os = "", arch = ""] = forced.split("-");
		return { os, arch };
	}
	return { os: process.platform, arch: process.arch };
}

/**
 * Copy the target's runtime files into `outDir` (replaced). Returns the files, or null (and an
 * empty `outDir`) when there is no build for the target.
 */
export function stageOnnxRuntime(
	target: { readonly os: string; readonly arch: string },
	outDir = ortOut,
	binDir = ortBinDir(),
): readonly string[] | null {
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	const files = ortFilesFor(target.os, target.arch);
	if (!files) return null;
	const from = join(binDir, target.os, target.arch);
	for (const f of files) {
		const src = join(from, f);
		if (!existsSync(src)) throw new Error(`onnxruntime-node is missing ${src}`);
		copyFileSync(src, join(outDir, f));
	}
	return files;
}
