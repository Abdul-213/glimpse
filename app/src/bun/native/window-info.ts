// GlimWindowInfo, the struct glim_list_windows fills (app/native/{macos/picker.m,
// windows/picker.cpp}). Pure decoding, so the layout is tested on Linux.
//
//   typedef struct {
//     double x, y, w, h;   //  0..31  macOS: global points. Windows: physical px.
//     int32_t pid;         // 32
//     int32_t z;           // 36      0 = frontmost
//     char app_name[64];   // 40..103 UTF-8, NUL-terminated
//   } GlimWindowInfo;      // 104 bytes
import type { Rect } from "@glimpse/core";

export const WINDOW_INFO_SIZE = 104;
const NAME_OFFSET = 40;
const NAME_BYTES = 64;

/** A window as the helper reports it: rect in the helper's own space (see above). */
export interface NativeWindowInfo {
	readonly rect: Rect;
	readonly pid: number;
	readonly z: number;
	readonly appName: string;
}

/** Decode `count` structs from `buf` (little-endian, as on every supported CPU). */
export function decodeWindowInfos(buf: Uint8Array, count: number): NativeWindowInfo[] {
	const n = Math.max(0, Math.min(count, Math.floor(buf.length / WINDOW_INFO_SIZE)));
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const text = new TextDecoder();
	const out: NativeWindowInfo[] = [];
	for (let i = 0; i < n; i++) {
		const o = i * WINDOW_INFO_SIZE;
		const nameBytes = buf.subarray(o + NAME_OFFSET, o + NAME_OFFSET + NAME_BYTES);
		const end = nameBytes.indexOf(0);
		out.push({
			rect: {
				x: view.getFloat64(o, true),
				y: view.getFloat64(o + 8, true),
				width: view.getFloat64(o + 16, true),
				height: view.getFloat64(o + 24, true),
			},
			pid: view.getInt32(o + 32, true),
			z: view.getInt32(o + 36, true),
			appName: text.decode(end >= 0 ? nameBytes.subarray(0, end) : nameBytes),
		});
	}
	return out;
}

/** Encode structs (tests and fakes). */
export function encodeWindowInfos(items: readonly NativeWindowInfo[]): Uint8Array {
	const buf = new Uint8Array(items.length * WINDOW_INFO_SIZE);
	const view = new DataView(buf.buffer);
	const enc = new TextEncoder();
	items.forEach((w, i) => {
		const o = i * WINDOW_INFO_SIZE;
		view.setFloat64(o, w.rect.x, true);
		view.setFloat64(o + 8, w.rect.y, true);
		view.setFloat64(o + 16, w.rect.width, true);
		view.setFloat64(o + 24, w.rect.height, true);
		view.setInt32(o + 32, w.pid, true);
		view.setInt32(o + 36, w.z, true);
		buf.set(enc.encode(w.appName).subarray(0, NAME_BYTES - 1), o + NAME_OFFSET);
	});
	return buf;
}

/**
 * Call a `glim_list_windows(out, cap, countOut, totalOut)`-shaped function, growing the
 * buffer once if more windows matched than fit. Returns the status and the windows.
 */
export function listNativeWindows(
	call: (buf: Uint8Array, cap: number, counts: Int32Array) => number,
	initialCap = 128,
): { status: number; windows: NativeWindowInfo[] } {
	let cap = initialCap;
	for (let attempt = 0; attempt < 2; attempt++) {
		const buf = new Uint8Array(cap * WINDOW_INFO_SIZE);
		const counts = new Int32Array(2); // [count, total]
		const status = call(buf, cap, counts);
		if (status !== 0) return { status, windows: [] };
		const [count = 0, total = 0] = counts;
		if (total <= cap || attempt === 1) return { status, windows: decodeWindowInfos(buf, count) };
		cap = total;
	}
	return { status: 0, windows: [] };
}
