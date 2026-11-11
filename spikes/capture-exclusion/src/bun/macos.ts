// macOS: loads native/macos/glimcapture.m (built into libglimcapture.dylib by
// `bun run native:mac`) with bun:ffi. See that file for why a dylib is needed.
import { PATHS } from "electrobun/main";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const DYLIB = "libglimcapture.dylib";

export function dylibCandidates(): string[] {
	const out: string[] = [];
	if (process.env.GLIM_CAPTURE_DYLIB) out.push(process.env.GLIM_CAPTURE_DYLIB);
	try {
		out.push(resolve(PATHS.RESOURCES_FOLDER, "app/native", DYLIB));
	} catch {
		// PATHS may not resolve outside a bundle
	}
	out.push(resolve(import.meta.dir, "../native", DYLIB));
	out.push(resolve(process.cwd(), "native/macos/build", DYLIB));
	return out;
}

function open(path: string) {
	return dlopen(path, {
		glim_cx_set_sharing: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		glim_cx_get_sharing: { args: [FFIType.ptr], returns: FFIType.i32 },
		glim_cx_window_number: { args: [FFIType.ptr], returns: FFIType.i32 },
		glim_cx_window_level: { args: [FFIType.ptr], returns: FFIType.i32 },
		glim_cx_preflight: { args: [], returns: FFIType.i32 },
		glim_cx_request: { args: [], returns: FFIType.i32 },
		glim_cx_os_version: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		glim_cx_capture: {
			args: [FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32],
			returns: FFIType.i32,
		},
	});
}

export interface SckDisplay {
	displayID: number;
	file: string;
	width: number;
	height: number;
	scale: number;
	frame: { x: number; y: number; width: number; height: number };
	ms: number;
	rgba?: Uint8Array;
}

export interface SckReport {
	ok: boolean;
	error?: string;
	mode?: number;
	pid?: number;
	ownAppFound?: boolean;
	ownBundleID?: string;
	excludeWindowId?: number;
	excludedWindowFound?: boolean;
	ownWindows?: { windowID: number; title: string; onScreen: boolean; layer: number; frame: unknown }[];
	displays?: SckDisplay[];
	errors?: string[];
	totalMs?: number;
	status: number;
}

function cstr(s: string): Buffer {
	return Buffer.from(s + "\0", "utf8");
}

export class MacCapture {
	private lib: ReturnType<typeof open>;
	readonly path: string;

	constructor() {
		const path = dylibCandidates().find((p) => existsSync(p));
		if (!path) {
			throw new Error(
				`${DYLIB} not found (run \`bun run native:mac\` before building). Looked in:\n  ${dylibCandidates().join("\n  ")}`,
			);
		}
		this.path = path;
		this.lib = open(path);
	}

	osVersion(): string {
		const buf = new Uint8Array(64);
		this.lib.symbols.glim_cx_os_version(ptr(buf), buf.length);
		return Buffer.from(buf).toString("utf8").replace(/\0.*$/s, "");
	}

	preflight(): boolean {
		return this.lib.symbols.glim_cx_preflight() === 1;
	}

	request(): boolean {
		return this.lib.symbols.glim_cx_request() === 1;
	}

	setSharing(win: Pointer, type: number): number {
		return this.lib.symbols.glim_cx_set_sharing(win, type);
	}

	getSharing(win: Pointer): number {
		return this.lib.symbols.glim_cx_get_sharing(win);
	}

	windowNumber(win: Pointer): number {
		return this.lib.symbols.glim_cx_window_number(win);
	}

	windowLevel(win: Pointer): number {
		return this.lib.symbols.glim_cx_window_level(win);
	}

	/** Blocks this (worker) thread until SCK finishes; reads and deletes the raw files. */
	capture(mode: number, excludeWindowId: number, outPrefix: string): SckReport {
		const json = new Uint8Array(256 * 1024);
		const prefix = cstr(outPrefix);
		const status = this.lib.symbols.glim_cx_capture(mode, excludeWindowId >>> 0, ptr(prefix), ptr(json), json.length);
		const text = Buffer.from(json).toString("utf8").replace(/\0.*$/s, "");
		let report: SckReport;
		try {
			report = { ...(JSON.parse(text) as Omit<SckReport, "status">), status };
		} catch {
			return { ok: false, error: `native returned ${status}, unparseable report: ${text.slice(0, 200)}`, status };
		}
		for (const d of report.displays ?? []) {
			try {
				d.rgba = new Uint8Array(readFileSync(d.file));
				unlinkSync(d.file);
			} catch (err) {
				report.errors = [...(report.errors ?? []), `read ${d.file}: ${String(err)}`];
			}
		}
		return report;
	}
}
