// bun:ffi bindings for Windows: glimpse.dll (capture) and plain user32 calls that need
// no helper (display affinity). See app/native/windows/glimpse.h for the C ABI.
// Nothing outside app/src/bun/native/ sees a raw pointer from here.
import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import type { CapturePiece, Rect, RgbaImage } from "@glimpse/core";
import { loadNativeLibrary, type NativeStatus, readNativeString } from "./load.ts";
import { captureErrorFor } from "./status.ts";

const glimpseSymbols = {
	glim_abi_version: { args: [], returns: FFIType.i32 },
	glim_last_error: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	glim_capture_displays_json: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	glim_capture_piece: {
		// backend, HMONITOR, geom[10], out, stride, len, seqOut
		args: [FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u64, FFIType.ptr],
		returns: FFIType.i32,
	},
	glim_capture_release: { args: [FFIType.i32], returns: FFIType.void },
} as const;

export type WindowsBackend = "gdi" | "dxgi";
const BACKEND_ID: Record<WindowsBackend | "all", number> = { all: 0, gdi: 1, dxgi: 2 };

/** A monitor as glimpse.dll reports it: physical virtual-desktop pixels, keyed by HMONITOR. */
export interface PhysicalDisplay {
	readonly id: number;
	readonly name: string;
	readonly bounds: Rect;
	readonly dpi: number;
	readonly primary: boolean;
}

/** What the Windows capture service needs from glimpse.dll. Faked in tests. */
export interface WindowsCaptureBinding {
	readonly status: NativeStatus;
	physicalDisplays(): PhysicalDisplay[];
	/** Capture `piece` into `out` at `piece.dest`. Returns the backend's content sequence. Throws CaptureError. */
	capturePiece(backend: WindowsBackend, piece: CapturePiece, out: RgbaImage): number;
	release(backend: WindowsBackend | "all"): void;
}

type GlimpseSymbols = NonNullable<ReturnType<typeof loadNativeLibrary<typeof glimpseSymbols>>["symbols"]>;

class GlimpseDll implements WindowsCaptureBinding {
	private readonly geom = new Int32Array(10);
	private readonly seq = new BigUint64Array(1);

	constructor(
		readonly status: NativeStatus,
		private readonly sym: GlimpseSymbols,
	) {}

	private lastError(): string {
		return readNativeString((b, c) => this.sym.glim_last_error(ptr(b), c), 1024);
	}

	physicalDisplays(): PhysicalDisplay[] {
		const json = readNativeString((b, c) => this.sym.glim_capture_displays_json(ptr(b), c));
		const parsed = JSON.parse(json) as { displays?: PhysicalDisplay[] };
		return parsed.displays ?? [];
	}

	capturePiece(backend: WindowsBackend, piece: CapturePiece, out: RgbaImage): number {
		const s = piece.source;
		const l = piece.sourceLocal;
		const d = piece.dest;
		this.geom.set([s.x, s.y, l.x, l.y, s.width, s.height, d.x, d.y, d.width, d.height]);
		const r = this.sym.glim_capture_piece(
			BACKEND_ID[backend],
			BigInt(piece.displayId),
			ptr(this.geom),
			ptr(out.data),
			out.width * 4,
			BigInt(out.data.length),
			ptr(this.seq),
		);
		if (r !== 0) throw captureErrorFor("windows", `${backend} capture`, r, this.lastError());
		return Number(this.seq[0]);
	}

	release(backend: WindowsBackend | "all"): void {
		this.sym.glim_capture_release(BACKEND_ID[backend]);
	}
}

let dll: WindowsCaptureBinding | { status: NativeStatus } | undefined;

/** Load glimpse.dll once. `binding` is null when it is missing or broken (see `status`). */
export function loadWindowsCapture(): { status: NativeStatus; binding: WindowsCaptureBinding | null } {
	if (!dll) {
		if (process.platform !== "win32") {
			dll = { status: { available: false, reason: "glimpse.dll is Windows-only" } };
		} else {
			const lib = loadNativeLibrary("windows", glimpseSymbols, "glim_abi_version");
			dll = lib.symbols ? new GlimpseDll(lib.status, lib.symbols) : { status: lib.status };
		}
	}
	return { status: dll.status, binding: dll instanceof GlimpseDll ? dll : null };
}

// ---- user32: display affinity (no helper needed, any thread may call it) ----------

export const WDA_NONE = 0x0;
export const WDA_EXCLUDEFROMCAPTURE = 0x11;

const user32Symbols = {
	SetWindowDisplayAffinity: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	GetWindowDisplayAffinity: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
} as const;

type User32 = ReturnType<typeof dlopen<typeof user32Symbols>>["symbols"];
let user32: User32 | null = null;

/** Opened on first use: dlopen("user32.dll") only makes sense on Windows. */
function openUser32(): User32 {
	user32 ??= dlopen("user32.dll", user32Symbols).symbols;
	return user32;
}

export interface AffinityResult {
	/** True when the read-back affinity is WDA_EXCLUDEFROMCAPTURE. */
	readonly excluded: boolean;
	/** GetWindowDisplayAffinity after the set, or null if it failed. */
	readonly affinity: number | null;
}

/**
 * SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE). The HWND must be a top-level
 * window of this process; there is no same-thread rule, so the Bun worker may call it
 * on Electrobun's windows. The read-back is the reliable signal (GetLastError may be
 * clobbered between FFI calls). Before Windows 10 2004 the OS silently treats it as
 * WDA_MONITOR (a black box in captures), which the read-back shows as 0x1.
 */
export function setWindowExcludedFromCapture(hwnd: Pointer, excluded = true): AffinityResult {
	const u = openUser32();
	u.SetWindowDisplayAffinity(hwnd, excluded ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE);
	const out = new Uint32Array(1);
	const ok = u.GetWindowDisplayAffinity(hwnd, ptr(out)) !== 0;
	const affinity = ok ? (out[0] ?? null) : null;
	return { excluded: affinity === WDA_EXCLUDEFROMCAPTURE, affinity };
}
