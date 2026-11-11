// macOS: loads native/macos/glimmaterial.m (libglimmaterial.dylib, built by
// `hutch run native:mac`) with bun:ffi. See that file for what each call does.

import { PATHS } from "electrobun/main";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DYLIB = "libglimmaterial.dylib";

export function dylibCandidates(): string[] {
	const out: string[] = [];
	if (process.env.GLIM_MATERIAL_DYLIB) out.push(process.env.GLIM_MATERIAL_DYLIB);
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
		glim_mat_install: {
			args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32],
			returns: FFIType.i32,
		},
		glim_mat_set_material: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		glim_mat_set_appearance: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		glim_mat_show: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		glim_mat_hide: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		glim_mat_last_show_timing: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		glim_mat_move_to_screen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		glim_mat_status: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		glim_mat_now_ns: { args: [], returns: FFIType.u64 },
	}).symbols;
}

function readJson(buf: Uint8Array): Record<string, unknown> {
	const text = Buffer.from(buf).toString("utf8").replace(/\0.*$/s, "");
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return { raw: text };
	}
}

/** Show/hide strategies. */
export const MAC_SHOW_MODES = ["orderFrontRegardless", "alpha", "activate", "electrobun-showInactive"] as const;
export type MacShowMode = (typeof MAC_SHOW_MODES)[number];

export class MacMaterial {
	private s: ReturnType<typeof open>;
	readonly path: string;

	constructor() {
		const path = dylibCandidates().find((p) => existsSync(p));
		if (!path) {
			throw new Error(`${DYLIB} not found. Run \`hutch run native:mac\` first. Looked in:\n  ${dylibCandidates().join("\n  ")}`);
		}
		this.path = path;
		this.s = open(path);
	}

	install(win: Pointer, o: { material: number; radius: number; cornerMethod: number; panel: boolean; level: number }) {
		const out = new Uint8Array(16 * 1024);
		const rc = this.s.glim_mat_install(win, o.material, o.radius, o.cornerMethod, o.panel ? 1 : 0, o.level, ptr(out), out.length);
		return { rc, ...readJson(out) };
	}

	setMaterial(win: Pointer, material: number, radius: number, cornerMethod: number): number {
		return this.s.glim_mat_set_material(win, material, radius, cornerMethod);
	}

	/** 0 system, 1 light, 2 dark */
	setAppearance(win: Pointer, mode: number): number {
		return this.s.glim_mat_set_appearance(win, mode);
	}

	/** mode: 0 orderFrontRegardless, 1 activate, 2 alpha */
	show(win: Pointer, mode: number): number {
		return this.s.glim_mat_show(win, mode);
	}

	hide(win: Pointer, mode: number): number {
		return this.s.glim_mat_hide(win, mode);
	}

	lastShowTiming(): Record<string, unknown> {
		const out = new Uint8Array(512);
		this.s.glim_mat_last_show_timing(ptr(out), out.length);
		return readJson(out);
	}

	moveToScreen(win: Pointer, index: number): number {
		return this.s.glim_mat_move_to_screen(win, index);
	}

	status(win: Pointer | null): Record<string, unknown> {
		const out = new Uint8Array(16 * 1024);
		this.s.glim_mat_status(win, ptr(out), out.length);
		return readJson(out);
	}
}
