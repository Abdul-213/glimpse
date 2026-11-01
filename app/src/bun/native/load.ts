// Finds and opens the per-OS native helper (ARCHITECTURE.md section 6). The only
// module besides macos.ts / windows.ts that touches bun:ffi's dlopen.
//
// Lookup order:
//   1. GLIMPSE_NATIVE_LIB (absolute path; for tests and debugging a custom build)
//   2. <bundle>/native/<file>: electrobun.config.ts copies the built library there,
//      and the bundled main process sits in <bundle>/bun/index.js
//   3. app/native/<os>/build/<file>: a dev build, when running from the source tree
import { dlopen, type FFIFunction } from "bun:ffi";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type NativeOs = "macos" | "windows";

export const NATIVE_FILE: Record<NativeOs, string> = {
	macos: "libglimpse.dylib",
	windows: "glimpse.dll",
};

/** ABI version the bindings expect from glim_abi_version(). Bump with the C side. */
export const GLIM_ABI_VERSION = 3;

export function nativeOsFor(platform: string): NativeOs | null {
	if (platform === "darwin") return "macos";
	if (platform === "win32") return "windows";
	return null;
}

/** Candidate library paths, most specific first. Pure, so it is tested on Linux. */
export function libraryCandidates(
	os: NativeOs,
	fromDir: string,
	env: Record<string, string | undefined> = process.env,
): string[] {
	const file = NATIVE_FILE[os];
	const out: string[] = [];
	const override = env["GLIMPSE_NATIVE_LIB"];
	if (override) out.push(resolve(override));
	// Bundled: <app>/bun/index.js -> <app>/native/<file>
	out.push(resolve(fromDir, "../native", file));
	// Source tree: app/src/bun/native/load.ts -> app/native/<os>/build/<file>
	out.push(resolve(fromDir, "../../../native", os, "build", file));
	return [...new Set(out)];
}

export type NativeStatus =
	| { readonly available: true; readonly path: string }
	| { readonly available: false; readonly reason: string };

export interface LoadedLibrary<S> {
	readonly status: NativeStatus;
	readonly symbols: S | null;
}

/**
 * dlopen the helper with `symbols`. Never throws: a missing file, a missing symbol or
 * an ABI mismatch comes back as `available: false` with a reason for diagnostics, and
 * the feature degrades (the app must still start).
 */
export function loadNativeLibrary<const T extends Record<string, FFIFunction>>(
	os: NativeOs,
	symbols: T,
	abiSymbol: keyof T & string,
	fromDir: string = import.meta.dir,
): LoadedLibrary<ReturnType<typeof dlopen<T>>["symbols"]> {
	const candidates = libraryCandidates(os, fromDir);
	const path = candidates.find((p) => existsSync(p));
	if (!path) {
		return {
			status: { available: false, reason: `${NATIVE_FILE[os]} not found (looked in ${candidates.join(", ")})` },
			symbols: null,
		};
	}
	try {
		const lib = dlopen(path, symbols);
		const abiFn = lib.symbols[abiSymbol] as unknown as () => number;
		const abi = abiFn();
		if (abi !== GLIM_ABI_VERSION) {
			lib.close();
			return {
				status: { available: false, reason: `${path}: ABI ${abi}, expected ${GLIM_ABI_VERSION}` },
				symbols: null,
			};
		}
		return { status: { available: true, path }, symbols: lib.symbols };
	} catch (e) {
		return {
			status: { available: false, reason: `${path}: ${e instanceof Error ? e.message : String(e)}` },
			symbols: null,
		};
	}
}

/** Read a C string the helper wrote with the `(char* buf, int32 cap) -> int32 length` convention. */
export function readNativeString(call: (buf: Uint8Array, cap: number) => number, initial = 4096): string {
	let buf = new Uint8Array(initial);
	let n = call(buf, buf.length);
	if (n >= buf.length) {
		buf = new Uint8Array(n + 1);
		n = call(buf, buf.length);
	}
	return new TextDecoder().decode(buf.subarray(0, Math.max(0, Math.min(n, buf.length - 1))));
}
