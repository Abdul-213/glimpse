// bun:ffi bindings for libglimpse.dylib (macOS). See app/native/macos/glimpse.h for the
// C ABI. Nothing outside app/src/bun/native/ sees a raw pointer from here, except the
// NSWindow* that window controllers already hold (BrowserWindow.ptr).
import { FFIType, JSCallback, type Pointer, ptr } from "bun:ffi";
import type { Rect, RgbaImage } from "@glimpse/core";
import type { NativeMaterial, ThemeSetting, WindowChromeNative } from "./chrome.ts";
import type { FrameHandle, FrameNativeBinding, FrameNativeStyle } from "./frame.ts";
import { loadNativeLibrary, type NativeStatus, readNativeString } from "./load.ts";
import {
	SESSION_KIND_CODE,
	type SessionEventKind,
	type SessionNativeBinding,
	sessionKindFor,
	sessionSourceName,
} from "./session.ts";
import { captureErrorFor, GLIM_E_NO_FRAME } from "./status.ts";
import { listNativeWindows, type NativeWindowInfo } from "./window-info.ts";

const symbols = {
	glim_abi_version: { args: [], returns: FFIType.i32 },
	glim_last_error: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	glim_window_exclude_from_capture: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	glim_window_number: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	glim_window_set_sharing: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	glim_capture_set_excluded_windows: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	// handle, dest i32[4], out, stride, len, seqOut
	glim_capture_stream_read: {
		args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u64, FFIType.ptr],
		returns: FFIType.i32,
	},
	glim_capture_stream_close: { args: [FFIType.u64], returns: FFIType.i32 },
	// GLIM-97: shot and stream start off the Bun worker (glim_capture_shot / _stream_open run on
	// the helper queue). token, displayID, src f64[4] (local points), dest i32[4] (px), out, stride, len
	glim_capture_async_init: { args: [FFIType.function], returns: FFIType.i32 },
	glim_capture_take_error: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	glim_capture_shot_async: {
		args: [FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u64],
		returns: FFIType.i32,
	},
	// token, displayID, src, width, height, fps
	glim_capture_stream_open_async: {
		args: [FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32],
		returns: FFIType.i32,
	},
	glim_capture_reset: { args: [], returns: FFIType.void },
	glim_capture_preflight: { args: [], returns: FFIType.i32 },
	glim_capture_displays_json: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	// GLIM-91 picker helpers (picker.m, window.m)
	// handle, x, y, size, out, len, seqOut
	glim_capture_stream_sample: {
		args: [FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.ptr],
		returns: FFIType.i32,
	},
	glim_list_windows: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	glim_focus_save: { args: [FFIType.ptr], returns: FFIType.i32 },
	glim_focus_restore: { args: [FFIType.ptr], returns: FFIType.i32 },
	glim_window_configure: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	glim_window_set_level: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	// GLIM-44 Carbon hot keys (hotkey.m)
	glim_hotkey_init: { args: [FFIType.function], returns: FFIType.i32 },
	glim_hotkey_register: { args: [FFIType.i32, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
	glim_hotkey_unregister: { args: [FFIType.i32], returns: FFIType.i32 },
	glim_hotkey_unregister_all: { args: [], returns: FFIType.i32 },
	glim_hotkey_shutdown: { args: [], returns: FFIType.i32 },
	// GLIM-90 pinned Live frame (frame.{m,cpp}): handle, rect f64[4], scale / style, palette u32[7], tag, text, below
	glim_frame_create: { args: [FFIType.ptr], returns: FFIType.i32 },
	glim_frame_set_rect: { args: [FFIType.u64, FFIType.ptr, FFIType.f64], returns: FFIType.i32 },
	glim_frame_set_style: {
		args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
		returns: FFIType.i32,
	},
	glim_frame_set_highlight: { args: [FFIType.u64, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	glim_frame_show: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
	glim_frame_window_id: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	glim_frame_destroy: { args: [FFIType.u64], returns: FFIType.i32 },
	glim_frame_info: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	// GLIM-119 lock / sleep notifications (session.m)
	glim_session_start: { args: [FFIType.function], returns: FFIType.i32 },
	glim_session_stop: { args: [], returns: FFIType.i32 },
	glim_session_simulate: { args: [FFIType.i32], returns: FFIType.i32 },
	glim_session_pump: { args: [FFIType.i32], returns: FFIType.i32 },
	glim_session_info: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	// GLIM-116 / GLIM-110 window chrome (material.m)
	glim_window_set_material: { args: [FFIType.ptr, FFIType.i32, FFIType.f64], returns: FFIType.i32 },
	glim_window_set_appearance: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	glim_window_set_frame: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	glim_reduce_transparency: { args: [], returns: FFIType.i32 },
	glim_window_material_info: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	glim_window_test_create: { args: [FFIType.ptr], returns: FFIType.i32 },
	glim_window_test_destroy: { args: [FFIType.ptr], returns: FFIType.i32 },
} as const;

/** A display as CoreGraphics reports it: global points + backing scale. */
export interface MacNativeDisplay {
	readonly id: number;
	readonly bounds: Rect;
	readonly scale: number;
	readonly primary: boolean;
}

/** Opaque handle of a running SCStream. */
export type StreamHandle = bigint;

/**
 * What the macOS capture service needs from libglimpse.dylib. Faked in tests.
 *
 * GLIM-97: nothing here blocks the Bun worker on ScreenCaptureKit. `shot` and `streamOpen`
 * run on the helper's own queue and settle through a threadsafe callback; `streamRead`
 * copies the newest frame without waiting; `streamClose` and the stream refilter after
 * `setExcludedWindows` finish on the helper queue.
 */
export interface MacCaptureBinding {
	readonly status: NativeStatus;
	/** Screen Recording granted to this process (CGPreflightScreenCaptureAccess; never prompts). */
	preflight(): boolean;
	/** CoreGraphics' display list (the harness uses it; the app uses Electrobun's Screen). */
	displays(): MacNativeDisplay[];
	/** Returns at once; running streams are refiltered in the background (failures: `onBackgroundError`). */
	setExcludedWindows(windowIds: readonly number[]): void;
	/** Failures of background work (the stream refilter). One listener; null removes it. */
	onBackgroundError(listener: ((error: unknown) => void) | null): void;
	/** One-shot capture of `source` (display-local points) into `dest` of `out`. Rejects with a CaptureError. */
	shot(displayId: number, source: Rect, dest: Rect, out: RgbaImage): Promise<void>;
	/** Start a stream; resolves once it runs and its first frame arrived (or 1 s passed). Rejects with a CaptureError. */
	streamOpen(displayId: number, source: Rect, width: number, height: number, fps: number): Promise<StreamHandle>;
	/**
	 * Latest frame of the stream into `dest` of `out`; returns its sequence. Never waits:
	 * throws a `temporarily-unavailable` CaptureError until the first frame is there.
	 */
	streamRead(handle: StreamHandle, dest: Rect, out: RgbaImage): number;
	/** Returns at once; the SCStream stops on the helper queue. */
	streamClose(handle: StreamHandle): void;
	reset(): void;
}

/** What window controllers need on macOS. */
export interface MacWindowBinding {
	/** NSWindow.sharingType = none; returns the CGWindowID (0 if the window has none yet). Throws. */
	excludeWindowFromCapture(nsWindow: Pointer): { windowNumber: number; sharingType: number };
	windowNumber(nsWindow: Pointer): number;
	/** GLIM-98: sharingType = none (hidden) or readOnly. Returns what reads back. Throws. */
	setWindowSharing(nsWindow: Pointer, hidden: boolean): { windowNumber: number; sharingType: number };
}

/** NSWindow levels the picker uses (spec 9.1). */
export const MAC_LEVEL = { picking: 1000, belowSnipPopup: 100 } as const;

/** What the region picker needs from libglimpse.dylib (GLIM-91). Faked in tests. */
export interface MacPickerBinding {
	/** On-screen windows of other apps, front to back, in global points. Throws CaptureError. */
	listWindows(): NativeWindowInfo[];
	/** Remember the frontmost app; returns its pid (0 if none). */
	focusSave(): number;
	/** Re-activate the saved app; true if it was activated. Throws CaptureError if macOS refused. */
	focusRestore(): boolean;
	/** Level, collection behaviour etc. for a picker overlay. Returns the collection behaviour. Throws. */
	configureOverlay(nsWindow: Pointer): number;
	/**
	 * The docked Live popup (GLIM-79, live-popup.md §7, §12.1): re-class to a non-activating
	 * `NSPanel`, level 101, all Spaces + full-screen auxiliary, `sharingType = none`, first click
	 * goes through. Returns 1 when the panel swap happened, 0 when it fell back to a plain window.
	 */
	configureLivePopup(nsWindow: Pointer): number;
	setLevel(nsWindow: Pointer, level: number): void;
	/**
	 * `size` x `size` px at (x, y) of a running stream's latest frame (stream px), RGBA into
	 * `out`. Returns the frame sequence, or null while the first frame hasn't arrived.
	 */
	streamSample(handle: StreamHandle, x: number, y: number, size: number, out: Uint8Array): number | null;
}

/** Smoke tests only (native-smoke.ts): a hidden NSWindow to check the chrome calls on CI. */
export interface MacChromeTestBinding {
	testWindowCreate(): Pointer;
	testWindowDestroy(window: Pointer): void;
	/** What the window reports: effect view, material, shadow, appearance, frame (global top-left points). */
	materialInfo(window: Pointer): Record<string, number> | null;
}

/** Carbon hot keys (GLIM-44). Status returns are OSStatus values (0 ok, -9878 taken). */
export interface MacHotkeyBinding {
	/** Install the handler once; `onPress(id)` runs on the Bun worker for each press. Returns OSStatus. */
	hotkeyInit(onPress: (id: number) => void): number;
	hotkeyRegister(id: number, keyCode: number, mods: number): number;
	hotkeyUnregister(id: number): number;
	hotkeyUnregisterAll(): void;
	hotkeyShutdown(): void;
}

type Symbols = NonNullable<ReturnType<typeof loadNativeLibrary<typeof symbols>>["symbols"]>;

class LibGlimpse
	implements
		MacCaptureBinding,
		MacWindowBinding,
		MacPickerBinding,
		MacHotkeyBinding,
		FrameNativeBinding,
		SessionNativeBinding,
		WindowChromeNative,
		MacChromeTestBinding
{
	private hotkeyCallback: JSCallback | null = null;
	private sessionCallback: JSCallback | null = null;
	/** GLIM-97 completion callback for the *_async calls; never closed (the helper may call it late). */
	private asyncCallback: JSCallback | null = null;
	private readonly pending = new Map<
		number,
		{ resolve: (value: number) => void; reject: (error: unknown) => void; what: string; keep: unknown }
	>();
	private nextToken = 1;
	private backgroundError: ((error: unknown) => void) | null = null;
	private readonly dest = new Int32Array(4);
	private readonly u32 = new Uint32Array(1);
	private readonly i32 = new Int32Array(1);
	private readonly u64 = new BigUint64Array(1);

	constructor(
		readonly status: NativeStatus,
		private readonly sym: Symbols,
	) {}

	private fail(what: string, status: number): never {
		throw captureErrorFor(
			"macos",
			what,
			status,
			readNativeString((b, c) => this.sym.glim_last_error(ptr(b), c), 1024),
		);
	}

	preflight(): boolean {
		return this.sym.glim_capture_preflight() === 1;
	}

	displays(): MacNativeDisplay[] {
		const json = readNativeString((b, c) => this.sym.glim_capture_displays_json(ptr(b), c));
		return (JSON.parse(json) as { displays?: MacNativeDisplay[] }).displays ?? [];
	}

	setExcludedWindows(windowIds: readonly number[]): void {
		this.ensureAsync();
		const ids = Uint32Array.from(windowIds.filter((id) => id > 0));
		const r = this.sym.glim_capture_set_excluded_windows(ids.length > 0 ? ptr(ids) : null, ids.length);
		if (r !== 0) this.fail("updating the capture exclusion list", r);
	}

	onBackgroundError(listener: ((error: unknown) => void) | null): void {
		this.backgroundError = listener;
	}

	/** Install the completion callback once. Runs on a helper queue thread; threadsafe queues it here. */
	private ensureAsync(): void {
		if (this.asyncCallback) return;
		const cb = new JSCallback((token: number, status: number, value: number) => this.complete(token, status, value), {
			args: [FFIType.i32, FFIType.i32, FFIType.i32],
			returns: FFIType.void,
			threadsafe: true,
		});
		const r = this.sym.glim_capture_async_init(cb);
		if (r !== 0) {
			cb.close();
			this.fail("installing the capture completion callback", r);
		}
		this.asyncCallback = cb;
	}

	private takeError(token: number): string {
		return readNativeString((b, c) => this.sym.glim_capture_take_error(token, ptr(b), c), 1024);
	}

	private complete(token: number, status: number, value: number): void {
		if (token === 0) {
			if (status !== 0) {
				this.backgroundError?.(captureErrorFor("macos", "refiltering the streams", status, this.takeError(0)));
			}
			return;
		}
		const p = this.pending.get(token);
		if (!p) return;
		this.pending.delete(token);
		if (status === 0) p.resolve(value);
		else p.reject(captureErrorFor("macos", p.what, status, this.takeError(token)));
	}

	/** Start an async helper call with a fresh token; settles from `complete`. `keep` stays reachable until then. */
	private async(what: string, keep: unknown, start: (token: number) => number): Promise<number> {
		this.ensureAsync();
		const token = this.nextToken;
		this.nextToken = this.nextToken >= 0x7fff_ffff ? 1 : this.nextToken + 1;
		return new Promise<number>((resolve, reject) => {
			this.pending.set(token, { resolve, reject, what, keep });
			const r = start(token);
			if (r !== 0) {
				this.pending.delete(token);
				reject(
					captureErrorFor(
						"macos",
						what,
						r,
						readNativeString((b, c) => this.sym.glim_last_error(ptr(b), c), 1024),
					),
				);
			}
		});
	}

	async shot(displayId: number, source: Rect, dest: Rect, out: RgbaImage): Promise<void> {
		// The helper copies src / dest before returning; `out` must live until the callback.
		const src = Float64Array.of(source.x, source.y, source.width, source.height);
		const d = Int32Array.of(dest.x, dest.y, dest.width, dest.height);
		await this.async("ScreenCaptureKit screenshot", out.data, (token) =>
			this.sym.glim_capture_shot_async(
				token,
				displayId >>> 0,
				ptr(src),
				ptr(d),
				ptr(out.data),
				out.width * 4,
				BigInt(out.data.length),
			),
		);
	}

	async streamOpen(displayId: number, source: Rect, width: number, height: number, fps: number): Promise<StreamHandle> {
		const src = Float64Array.of(source.x, source.y, source.width, source.height);
		const handle = await this.async("starting the ScreenCaptureKit stream", null, (token) =>
			this.sym.glim_capture_stream_open_async(
				token,
				displayId >>> 0,
				ptr(src),
				width,
				height,
				Math.max(1, Math.round(fps)),
			),
		);
		return BigInt(handle);
	}

	streamRead(handle: StreamHandle, dest: Rect, out: RgbaImage): number {
		this.dest.set([dest.x, dest.y, dest.width, dest.height]);
		const r = this.sym.glim_capture_stream_read(
			handle,
			ptr(this.dest),
			ptr(out.data),
			out.width * 4,
			BigInt(out.data.length),
			ptr(this.u64),
		);
		if (r !== 0) this.fail("reading the ScreenCaptureKit stream", r);
		return Number(this.u64[0] ?? 0n);
	}

	streamClose(handle: StreamHandle): void {
		this.sym.glim_capture_stream_close(handle);
	}

	reset(): void {
		this.sym.glim_capture_reset();
	}

	excludeWindowFromCapture(nsWindow: Pointer): { windowNumber: number; sharingType: number } {
		const r = this.sym.glim_window_exclude_from_capture(nsWindow, ptr(this.u32), ptr(this.i32));
		if (r !== 0) this.fail("NSWindow sharingType", r);
		return { windowNumber: this.u32[0] ?? 0, sharingType: this.i32[0] ?? -1 };
	}

	setWindowSharing(nsWindow: Pointer, hidden: boolean): { windowNumber: number; sharingType: number } {
		const r = this.sym.glim_window_set_sharing(nsWindow, hidden ? 1 : 0, ptr(this.u32), ptr(this.i32));
		if (r !== 0) this.fail("NSWindow sharingType", r);
		return { windowNumber: this.u32[0] ?? 0, sharingType: this.i32[0] ?? -1 };
	}

	windowNumber(nsWindow: Pointer): number {
		const r = this.sym.glim_window_number(nsWindow, ptr(this.u32));
		if (r !== 0) this.fail("NSWindow windowNumber", r);
		return this.u32[0] ?? 0;
	}

	listWindows(): NativeWindowInfo[] {
		const { status, windows } = listNativeWindows((buf, cap, counts) =>
			this.sym.glim_list_windows(ptr(buf), cap, ptr(counts), ptr(counts, 4)),
		);
		if (status !== 0) this.fail("CGWindowListCopyWindowInfo", status);
		return windows;
	}

	focusSave(): number {
		const r = this.sym.glim_focus_save(ptr(this.u64));
		if (r !== 0) this.fail("saving the frontmost app", r);
		return Number(this.u64[0] ?? 0n);
	}

	focusRestore(): boolean {
		const r = this.sym.glim_focus_restore(ptr(this.i32));
		if (r !== 0) this.fail("re-activating the previous app", r);
		return this.i32[0] === 1;
	}

	configureOverlay(nsWindow: Pointer): number {
		const behavior = new BigInt64Array(1);
		const r = this.sym.glim_window_configure(nsWindow, 0, ptr(behavior));
		if (r !== 0) this.fail("configuring the picker overlay", r);
		return Number(behavior[0] ?? 0n);
	}

	configureLivePopup(nsWindow: Pointer): number {
		const out = new BigInt64Array(1);
		const r = this.sym.glim_window_configure(nsWindow, 1, ptr(out));
		if (r !== 0) this.fail("configuring the Live popup panel", r);
		return Number(out[0] ?? 0n);
	}

	setLevel(nsWindow: Pointer, level: number): void {
		const r = this.sym.glim_window_set_level(nsWindow, level);
		if (r !== 0) this.fail("NSWindow level", r);
	}

	hotkeyInit(onPress: (id: number) => void): number {
		if (this.hotkeyCallback) return 0;
		// Runs on the AppKit main thread; threadsafe queues it onto this worker.
		const cb = new JSCallback(
			(id: number, kind: number) => {
				if (kind === 1) onPress(id);
			},
			{ args: [FFIType.i32, FFIType.i32], returns: FFIType.void, threadsafe: true },
		);
		const r = this.sym.glim_hotkey_init(cb);
		if (r === 0) this.hotkeyCallback = cb;
		else cb.close();
		return r;
	}

	hotkeyRegister(id: number, keyCode: number, mods: number): number {
		return this.sym.glim_hotkey_register(id, keyCode >>> 0, mods >>> 0);
	}

	hotkeyUnregister(id: number): number {
		return this.sym.glim_hotkey_unregister(id);
	}

	hotkeyUnregisterAll(): void {
		this.sym.glim_hotkey_unregister_all();
	}

	hotkeyShutdown(): void {
		this.sym.glim_hotkey_shutdown();
		this.hotkeyCallback?.close();
		this.hotkeyCallback = null;
	}

	// ---- GLIM-116 / GLIM-110 window chrome ----

	reduceTransparency(): boolean {
		return this.sym.glim_reduce_transparency() === 1;
	}

	systemDark(): boolean | null {
		// A window with appearance nil follows the system by itself; nothing to read.
		return null;
	}

	windowsBuild(): number | null {
		return null;
	}

	setMaterial(window: Pointer, material: NativeMaterial): void {
		const r =
			material.kind === "mac-effect"
				? this.sym.glim_window_set_material(window, material.material, material.radius)
				: this.sym.glim_window_set_material(window, -1, 0);
		if (r !== 0) this.fail("setting the window material", r);
	}

	setAppearance(window: Pointer, theme: ThemeSetting, _dark: boolean): void {
		const r = this.sym.glim_window_set_appearance(window, theme === "light" ? 1 : theme === "dark" ? 2 : 0);
		if (r !== 0) this.fail("setting the window appearance", r);
	}

	setFrame(window: Pointer, frame: Rect): void {
		const r = this.sym.glim_window_set_frame(window, ptr(Float64Array.of(frame.x, frame.y, frame.width, frame.height)));
		if (r !== 0) this.fail("NSWindow setFrame", r);
	}

	testWindowCreate(): Pointer {
		const out = new BigUint64Array(1);
		const r = this.sym.glim_window_test_create(ptr(out));
		if (r !== 0) this.fail("creating a test window", r);
		return Number(out[0] ?? 0n) as Pointer;
	}

	testWindowDestroy(window: Pointer): void {
		this.sym.glim_window_test_destroy(window);
	}

	materialInfo(window: Pointer): Record<string, number> | null {
		const json = readNativeString((b, c) => this.sym.glim_window_material_info(window, ptr(b), c), 512);
		return json.startsWith("{") ? (JSON.parse(json) as Record<string, number>) : null;
	}

	// ---- GLIM-119 lock / sleep notifications ----

	sessionStart(onEvent: (kind: SessionEventKind, source: string) => void): number {
		// Runs on the AppKit main thread; threadsafe queues it onto this worker.
		const cb = new JSCallback(
			(kind: number, source: number) => {
				const k = sessionKindFor(kind);
				if (k) onEvent(k, sessionSourceName("macos", source));
			},
			{ args: [FFIType.i32, FFIType.i32], returns: FFIType.void, threadsafe: true },
		);
		const r = this.sym.glim_session_start(cb);
		if (r !== 0) {
			cb.close();
			return r;
		}
		// The helper now calls the new callback; the old one can go.
		this.sessionCallback?.close();
		this.sessionCallback = cb;
		return 0;
	}

	sessionStop(): void {
		this.sym.glim_session_stop();
		this.sessionCallback?.close();
		this.sessionCallback = null;
	}

	sessionSimulate(kind: SessionEventKind): number {
		return this.sym.glim_session_simulate(SESSION_KIND_CODE[kind]);
	}

	sessionPump(ms: number): void {
		this.sym.glim_session_pump(Math.max(0, Math.round(ms)));
	}

	sessionInfo(): Record<string, number> | null {
		const json = readNativeString((b, c) => this.sym.glim_session_info(ptr(b), c), 256);
		return json.startsWith("{") ? (JSON.parse(json) as Record<string, number>) : null;
	}

	// ---- GLIM-90 pinned Live frame ----

	frameCreate(): FrameHandle {
		const out = new BigUint64Array(1);
		const r = this.sym.glim_frame_create(ptr(out));
		if (r !== 0) this.fail("creating the Live frame window", r);
		return out[0] ?? 0n;
	}

	frameSetRect(handle: FrameHandle, region: Rect, scale: number): void {
		const r = this.sym.glim_frame_set_rect(
			handle,
			ptr(Float64Array.of(region.x, region.y, region.width, region.height)),
			scale,
		);
		if (r !== 0) this.fail("placing the Live frame", r);
	}

	frameSetStyle(handle: FrameHandle, style: FrameNativeStyle): void {
		const text = new TextEncoder().encode(`${style.tagText}\0`);
		const r = this.sym.glim_frame_set_style(
			handle,
			style.paused ? 1 : 0,
			ptr(style.palette),
			style.tag,
			ptr(text),
			style.tagBelow ? 1 : 0,
		);
		if (r !== 0) this.fail("styling the Live frame", r);
	}

	frameSetHighlight(handle: FrameHandle, box: Rect | null): void {
		const r = box
			? this.sym.glim_frame_set_highlight(handle, 1, ptr(Float64Array.of(box.x, box.y, box.width, box.height)))
			: this.sym.glim_frame_set_highlight(handle, 0, null);
		if (r !== 0) this.fail("highlighting a block on the Live frame", r);
	}

	frameShow(handle: FrameHandle, visible: boolean): void {
		const r = this.sym.glim_frame_show(handle, visible ? 1 : 0);
		if (r !== 0) this.fail("showing the Live frame", r);
	}

	frameWindowId(handle: FrameHandle): number {
		const out = new BigUint64Array(1);
		const r = this.sym.glim_frame_window_id(handle, ptr(out));
		if (r !== 0) this.fail("reading the Live frame window id", r);
		return Number(out[0] ?? 0n);
	}

	frameDestroy(handle: FrameHandle): void {
		this.sym.glim_frame_destroy(handle);
	}

	frameInfo(handle: FrameHandle): Record<string, number> | null {
		const json = readNativeString((b, c) => this.sym.glim_frame_info(handle, ptr(b), c), 512);
		return json.startsWith("{") ? (JSON.parse(json) as Record<string, number>) : null;
	}

	streamSample(handle: StreamHandle, x: number, y: number, size: number, out: Uint8Array): number | null {
		const r = this.sym.glim_capture_stream_sample(handle, x, y, size, ptr(out), BigInt(out.length), ptr(this.u64));
		if (r === GLIM_E_NO_FRAME) return null;
		if (r !== 0) this.fail("sampling the ScreenCaptureKit stream", r);
		return Number(this.u64[0] ?? 0n);
	}
}

let lib: LibGlimpse | { status: NativeStatus } | undefined;

/** Load libglimpse.dylib once. `binding` is null when it is missing or broken (see `status`). */
export function loadMacNative(): {
	status: NativeStatus;
	binding:
		| (MacCaptureBinding &
				MacWindowBinding &
				MacPickerBinding &
				MacHotkeyBinding &
				FrameNativeBinding &
				SessionNativeBinding &
				WindowChromeNative &
				MacChromeTestBinding)
		| null;
} {
	if (!lib) {
		if (process.platform !== "darwin") {
			lib = { status: { available: false, reason: "libglimpse.dylib is macOS-only" } };
		} else {
			const loaded = loadNativeLibrary("macos", symbols, "glim_abi_version");
			lib = loaded.symbols ? new LibGlimpse(loaded.status, loaded.symbols) : { status: loaded.status };
		}
	}
	return { status: lib.status, binding: lib instanceof LibGlimpse ? lib : null };
}
