// onnxruntime-node in the built app (GLIM-103). The npm package ships every platform's native
// binaries (~260 MB) under bin/napi-v6/<os>/<arch>/; the app needs only the target's, and only
// what the CPU execution provider loads:
//
//   linux  x64/arm64  onnxruntime_binding.node + libonnxruntime.so.1      (RUNPATH $ORIGIN)
//   darwin arm64      onnxruntime_binding.node + libonnxruntime.1.dylib   (@rpath, @loader_path)
//   darwin x64        onnxruntime_binding.node + libonnxruntime.1.23.2.dylib  (GLIM-89: pinned 1.23.2,
//                     the last Intel Mac build; see onnxruntime-legacy.ts)
//   win32  x64/arm64  onnxruntime_binding.node + onnxruntime.dll
//
// Left out on purpose:
// - darwin libonnxruntime.1.31.1.dylib: a byte-identical copy (npm has no symlinks); the
//   binding links @rpath/libonnxruntime.1.dylib.
// - win32 DirectML.dll + dxcompiler.dll (36 MB): onnxruntime.dll only delay-loads DirectML.dll
//   (with d3d12/dxgi) when the DirectML provider is used, and dxcompiler.dll is LoadLibrary'd
//   by the WebGPU provider. Checked from the PE import tables of 1.31.1; we only use CPU.
//
// Windows: onnxruntime.dll and the binding link the Microsoft Visual C++ runtime (MSVCP140*.dll,
// VCRUNTIME140*.dll), which is not part of Windows. A PC without the VC++ 2015-2022
// redistributable could not load local OCR, so the build copies the runtime DLLs the staged files
// import (read from their PE import tables, see pe-imports.ts) next to them, app-local, from the
// build machine's Visual Studio redist folder (GLIM-111, docs/decisions/GLIM-111-msvc-runtime.md).
// Windows looks for a DLL's dependencies in that DLL's own folder first, so these copies are used
// even on PCs that also have the redistributable installed.
//
// The preBuild hook stages the files into dist/onnxruntime/; electrobun.config.ts copies that to
// <app>/native/onnxruntime/, and the bundled OCR Worker (<app>/bun/ocr-worker.js) loads the
// binding from ../native/onnxruntime/ (see ortBindingPlugin in build-workers.ts).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { peImports } from "./pe-imports.ts";

export const ORT_BINDING = "onnxruntime_binding.node";
export const ortOut = resolve(import.meta.dir, "..", "dist", "onnxruntime");

const LIBS: Readonly<Record<string, readonly string[]>> = {
	"linux-x64": ["libonnxruntime.so.1"],
	"linux-arm64": ["libonnxruntime.so.1"],
	"darwin-arm64": ["libonnxruntime.1.dylib"],
	// GLIM-89: from the pinned onnxruntime-node 1.23.2 (onnxruntime-legacy.ts), not the npm dependency.
	"darwin-x64": ["libonnxruntime.1.23.2.dylib"],
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

/** The Visual C++ runtime DLLs (the redistributable's Microsoft.VC14x.CRT folder). */
const VC_RUNTIME_DLL = /^(?:msvcp140(?:_[a-z0-9_]+)?|vcruntime140(?:_[a-z0-9_]+)?|concrt140)\.dll$/i;

/**
 * The Visual C++ runtime DLLs the staged Windows files import, lower-case, sorted. Empty for other
 * targets (their binaries aren't PE files). `dir` holds the staged files (see `stageOnnxRuntime`).
 */
export function vcRuntimeImports(dir: string, files: readonly string[]): string[] {
	const needed = new Set<string>();
	for (const f of files) {
		const bytes = readFileSync(join(dir, f));
		if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) continue; // not a PE image (ELF, Mach-O)
		for (const name of peImports(bytes)) {
			if (VC_RUNTIME_DLL.test(name)) needed.add(name.toLowerCase());
		}
	}
	return [...needed].sort();
}

/** The redist folder's arch name for a Node arch. */
const REDIST_ARCH: Readonly<Record<string, string>> = { x64: "x64", arm64: "arm64", ia32: "x86" };

/** `<redist>/<arch>/Microsoft.VC14x.CRT`, newest toolset first, if present. */
function crtFolderIn(redist: string, arch: string, exists: (p: string) => boolean, list: (p: string) => string[]) {
	const archDir = join(redist, REDIST_ARCH[arch] ?? arch);
	if (!exists(archDir)) return null;
	const crt = list(archDir)
		.filter((d) => /^Microsoft\.VC\d+\.CRT$/i.test(d))
		.sort()
		.reverse()[0];
	return crt ? join(archDir, crt) : null;
}

export interface VcRuntimeLookup {
	readonly env?: Record<string, string | undefined>;
	readonly exists?: (path: string) => boolean;
	readonly list?: (path: string) => string[];
}

/**
 * Where to copy the Visual C++ runtime from, or null if no Visual Studio redist folder is found:
 *   1. GLIMPSE_VCRT_DIR: a folder holding the DLLs (any machine; e.g. a /layout of vc_redist)
 *   2. %VCToolsRedistDir%<arch>\Microsoft.VC14x.CRT (a VS developer prompt, or ilammy/msvc-dev-cmd in CI)
 *   3. Visual Studio 2022+ installs under %ProgramFiles% / %ProgramFiles(x86)%:
 *      Microsoft Visual Studio\<year>\<edition>\VC\Redist\MSVC\<version>\<arch>\Microsoft.VC14x.CRT
 * Only these redist folders: their files are the "Distributable Code" the VS licence lets us ship.
 */
export function findVcRuntimeDir(arch: string, lookup: VcRuntimeLookup = {}): string | null {
	const env = lookup.env ?? process.env;
	const exists = lookup.exists ?? existsSync;
	const list = lookup.list ?? ((p: string) => readdirSync(p));
	const forced = env["GLIMPSE_VCRT_DIR"];
	if (forced) return forced;
	const tools = env["VCToolsRedistDir"];
	if (tools) {
		const crt = crtFolderIn(tools, arch, exists, list);
		if (crt) return crt;
	}
	const dirs = (p: string) => (exists(p) ? list(p).sort().reverse() : []);
	for (const root of [env["ProgramFiles"], env["ProgramFiles(x86)"]]) {
		if (!root) continue;
		const vs = join(root, "Microsoft Visual Studio");
		for (const year of dirs(vs)) {
			for (const edition of dirs(join(vs, year))) {
				const msvc = join(vs, year, edition, "VC", "Redist", "MSVC");
				for (const version of dirs(msvc).filter((v) => /^\d/.test(v))) {
					const crt = crtFolderIn(join(msvc, version), arch, exists, list);
					if (crt) return crt;
				}
			}
		}
	}
	return null;
}

/**
 * Copy the Visual C++ runtime DLLs that the staged files in `outDir` import from `crtDir` into
 * `outDir`. Returns the DLLs copied. Throws if one is missing from `crtDir`, so a build never
 * ships half a runtime.
 */
export function stageVcRuntime(outDir: string, files: readonly string[], crtDir: string): string[] {
	const needed = vcRuntimeImports(outDir, files);
	const available = new Map(readdirSync(crtDir).map((f) => [f.toLowerCase(), f] as const));
	for (const dll of needed) {
		const name = available.get(dll);
		if (!name) throw new Error(`${crtDir} has no ${dll} (needed by onnxruntime)`);
		copyFileSync(join(crtDir, name), join(outDir, dll));
	}
	return needed;
}
