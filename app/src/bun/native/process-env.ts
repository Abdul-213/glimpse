// Set a variable in the real process environment, where native libraries read it with
// getenv / GetEnvironmentVariableW (GLIM-112). Assigning `process.env.X` in Bun only changes the
// JavaScript copy (checked on Bun 1.4.4: libc getenv still returns NULL afterwards), so a native
// library loaded later never sees it. This calls setenv(3) (Linux, macOS) or
// SetEnvironmentVariableW (Windows) through bun:ffi, and also updates `process.env` so child
// processes and JS readers agree.
import { dlopen, FFIType, ptr } from "bun:ffi";

const LIBC: Readonly<Record<string, string>> = {
	linux: "libc.so.6",
	darwin: "libSystem.B.dylib",
};

/** Set `name=value` for this process and its native code. Returns false if that wasn't possible. */
export function setProcessEnv(name: string, value: string, platform: string = process.platform): boolean {
	process.env[name] = value;
	try {
		if (platform === "win32") {
			// Keep the buffers referenced until the call returns (ptr() alone doesn't).
			const n = Buffer.from(`${name}\0`, "utf16le");
			const v = Buffer.from(`${value}\0`, "utf16le");
			const lib = dlopen("kernel32.dll", {
				SetEnvironmentVariableW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			});
			try {
				return lib.symbols.SetEnvironmentVariableW(ptr(n), ptr(v)) !== 0;
			} finally {
				lib.close();
			}
		}
		const libc = LIBC[platform];
		if (!libc) return false;
		const n = Buffer.from(`${name}\0`, "utf8");
		const v = Buffer.from(`${value}\0`, "utf8");
		const lib = dlopen(libc, { setenv: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 } });
		try {
			return lib.symbols.setenv(ptr(n), ptr(v), 1) === 0;
		} finally {
			lib.close();
		}
	} catch {
		return false;
	}
}
