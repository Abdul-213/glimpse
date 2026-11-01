// bun:ffi binding for the per-OS native library (same C ABI on both OSes).
//   macOS:   native/macos/GlimCapture.swift  -> libglimcapture.dylib
//   Windows: native/windows/glimcapture.cpp  -> glimcapture.dll
// Pixels: Bun allocates the RGBA Uint8Array, passes ptr(data); native writes into
// it. No copy back, no serialisation.
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CapturePlan, NativeDisplay } from "../core/geometry";
import type { RgbaImage } from "../core/pixels";
import { fillOpaqueBlack } from "../core/pixels";

export const BACKEND_IDS = {
	"sck-shot": 1,
	"sck-stream": 2,
	gdi: 10,
	dxgi: 11,
	wgc: 12,
} as const;
export type NativeBackendName = keyof typeof BACKEND_IDS;

export const OPT = { cursor: 1, wgcBorder: 2, streamFps: 3, captureBlt: 5 } as const;

const ERRORS: Record<number, string> = {
	[-1]: "bad arguments",
	[-2]: "display not found",
	[-3]: "unsupported on this OS version",
	[-4]: "OS API call failed",
	[-5]: "no frame available",
	[-6]: "unknown backend",
	[-7]: "timed out",
	[-3801]: "ScreenCaptureKit: user declined (Screen Recording not granted)",
};

export function libFileName(platform = process.platform): string {
	return platform === "win32" ? "glimcapture.dll" : "libglimcapture.dylib";
}

/** Candidate paths: env override, Electrobun bundle copy, then the dev build dir. */
export function libCandidates(platform = process.platform, from = import.meta.dir): string[] {
	const name = libFileName(platform);
	const os = platform === "win32" ? "windows" : "macos";
	const c: string[] = [];
	if (process.env.GLIM_CAPTURE_LIB) c.push(process.env.GLIM_CAPTURE_LIB);
	// Walk up from this file: inside an Electrobun bundle the copy target is
	// <app resources>/native/<name>; in the source tree it is native/<os>/build/<name>.
	let dir = from;
	for (let i = 0; i < 8; i++) {
		c.push(join(dir, "native", name));
		c.push(join(dir, "native", os, "build", name));
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return c.map((p) => resolve(p));
}

const commonSymbols = {
	gc_abi_version: { args: [], returns: FFIType.i32 },
	gc_last_error: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	gc_displays_json: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	gc_set_option: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	gc_reset: { args: [], returns: FFIType.void },
	gc_stats_json: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	gc_capture_piece: {
		args: [
			FFIType.i32, // backend
			FFIType.u64, // display id
			FFIType.f64, // gx
			FFIType.f64, // gy
			FFIType.f64, // lx
			FFIType.f64, // ly
			FFIType.f64, // w
			FFIType.f64, // h
			FFIType.i32, // dx
			FFIType.i32, // dy
			FFIType.i32, // dw
			FFIType.i32, // dh
			FFIType.ptr, // out
			FFIType.i32, // out stride
			FFIType.u64, // out length
		],
		returns: FFIType.i32,
	},
} as const;

const macSymbols = {
	...commonSymbols,
	gc_mac_preflight: { args: [], returns: FFIType.i32 },
	gc_mac_request: { args: [], returns: FFIType.i32 },
	gc_mac_sck_probe: { args: [FFIType.i32], returns: FFIType.i32 },
} as const;

const winSymbols = {
	...commonSymbols,
	gc_wgc_request_borderless: { args: [FFIType.i32], returns: FFIType.i32 },
} as const;

export interface DisplaysInfo {
	platform: string;
	os?: string;
	dpiMode?: string;
	displays: NativeDisplay[];
}

export class NativeLib {
	readonly path: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private sym: any;
	private strBuf = new Uint8Array(64 * 1024);

	private constructor(path: string, sym: unknown) {
		this.path = path;
		this.sym = sym;
	}

	static load(platform = process.platform): NativeLib {
		if (platform !== "darwin" && platform !== "win32") {
			throw new Error(`no native capture library for ${platform} (spike targets macOS and Windows)`);
		}
		const cands = libCandidates(platform);
		const path = cands.find((p) => existsSync(p));
		if (!path) {
			throw new Error(
				`native library ${libFileName(platform)} not found; build it first (see TESTING.md). Looked in:\n  ${cands.join("\n  ")}`,
			);
		}
		return NativeLib.loadFrom(path, platform);
	}

	/** Load a specific file with the given OS's symbol table (tests use a Linux fake). */
	static loadFrom(path: string, symbolsFor: string): NativeLib {
		const lib = dlopen(path, symbolsFor === "darwin" ? macSymbols : winSymbols);
		const n = new NativeLib(path, lib.symbols);
		const abi = n.sym.gc_abi_version();
		if (abi !== 1) throw new Error(`native ABI ${abi}, expected 1 (${path})`);
		return n;
	}

	private readString(fn: (p: Pointer, cap: number) => number): string {
		let need = fn(ptr(this.strBuf), this.strBuf.length);
		if (need >= this.strBuf.length) {
			this.strBuf = new Uint8Array(need + 1);
			need = fn(ptr(this.strBuf), this.strBuf.length);
		}
		return new TextDecoder().decode(this.strBuf.subarray(0, need));
	}

	lastError(): string {
		return this.readString((p, c) => this.sym.gc_last_error(p, c));
	}

	displays(): DisplaysInfo {
		return JSON.parse(this.readString((p, c) => this.sym.gc_displays_json(p, c)));
	}

	stats(): unknown {
		return JSON.parse(this.readString((p, c) => this.sym.gc_stats_json(p, c)));
	}

	setOption(key: number, value: number | boolean): void {
		const r = this.sym.gc_set_option(key, Number(value));
		if (r !== 0) throw new Error(`gc_set_option(${key}) failed: ${this.lastError()}`);
	}

	reset(): void {
		this.sym.gc_reset();
	}

	/** Capture every piece of `plan` into `img` (which must be plan.outWidth x plan.outHeight). */
	capture(backend: NativeBackendName, plan: CapturePlan, img: RgbaImage): void {
		if (img.width !== plan.outWidth || img.height !== plan.outHeight) {
			throw new Error(`image ${img.width}x${img.height} does not match plan ${plan.outWidth}x${plan.outHeight}`);
		}
		if (plan.pieces.length === 0) throw new Error("region is not on any display");
		if (plan.hasUncovered) fillOpaqueBlack(img);
		const id = BACKEND_IDS[backend];
		const p = ptr(img.data);
		const stride = img.width * 4;
		const len = BigInt(img.data.length);
		for (const piece of plan.pieces) {
			const r = this.sym.gc_capture_piece(
				id,
				BigInt(piece.displayId),
				piece.global.x,
				piece.global.y,
				piece.local.x,
				piece.local.y,
				piece.local.width,
				piece.local.height,
				piece.dest.x,
				piece.dest.y,
				piece.dest.width,
				piece.dest.height,
				p,
				stride,
				len,
			);
			if (r !== 0) {
				throw new Error(`${backend} capture failed (${r}: ${ERRORS[r] ?? "error"}): ${this.lastError()}`);
			}
		}
	}

	// macOS only
	macPreflight(): boolean {
		return this.sym.gc_mac_preflight() === 1;
	}
	macRequest(): boolean {
		return this.sym.gc_mac_request() === 1;
	}
	macSckProbe(timeoutMs = 3000): { ok: true } | { ok: false; code: number; message: string } {
		const r = this.sym.gc_mac_sck_probe(timeoutMs);
		return r === 0 ? { ok: true } : { ok: false, code: r, message: ERRORS[r] ?? this.lastError() };
	}

	// Windows only
	wgcRequestBorderless(timeoutMs = 60_000): { status: number; meaning: string; error?: string } {
		const r = this.sym.gc_wgc_request_borderless(timeoutMs);
		const names = ["DeniedBySystem", "NotDeclaredByApp", "DeniedByUser", "UserPromptRequired", "Allowed"];
		return r >= 0
			? { status: r, meaning: names[r] ?? "unknown" }
			: { status: r, meaning: ERRORS[r] ?? "error", error: this.lastError() };
	}
}
