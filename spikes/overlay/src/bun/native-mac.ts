// macOS escape hatch: drive AppKit directly through bun:ffi + the Objective-C
// runtime, using the NSWindow* that Electrobun exposes as BrowserWindow.ptr.
//
// Why this exists: Electrobun's setAlwaysOnTop() only uses NSFloatingWindowLevel
// (3), which sits below the Dock (20) and the menu bar (24), and Electrobun
// gives every window NSWindowCollectionBehaviorFullScreenPrimary, which is the
// wrong behaviour for an overlay that must join fullscreen Spaces.
//
// Threading: Electrobun runs our JS on a worker thread; AppKit must be touched
// on the main thread. We therefore never call setters directly. Instead we ask
// the main thread to run -[NSObject setValuesForKeysWithDictionary:] via
// -performSelectorOnMainThread:withObject:waitUntilDone:. KVC unboxes the
// NSNumbers into the scalar setters (setLevel:, setCollectionBehavior:, ...),
// so we get main-thread mutation with zero native code of our own.
// Getters (level, collectionBehavior) are read from the worker for diagnostics
// only.

import { dlopen, FFIType, type Pointer } from "bun:ffi";

const LIBOBJC = "/usr/lib/libobjc.A.dylib";
const COREGRAPHICS = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";

// NSWindowCollectionBehavior bits (AppKit NSWindow.h)
export const NSWindowCollectionBehavior = {
	CanJoinAllSpaces: 1 << 0,
	MoveToActiveSpace: 1 << 1,
	Managed: 1 << 2,
	Transient: 1 << 3,
	Stationary: 1 << 4,
	ParticipatesInCycle: 1 << 5,
	IgnoresCycle: 1 << 6,
	FullScreenPrimary: 1 << 7,
	FullScreenAuxiliary: 1 << 8,
	FullScreenNone: 1 << 9,
} as const;

// Window levels (CGWindowLevel.h / NSWindow.h)
export const NSWindowLevel = {
	Normal: 0,
	Floating: 3,
	Dock: 20,
	MainMenu: 24,
	Status: 25,
	PopUpMenu: 101,
	ScreenSaver: 1000,
} as const;

type ObjcLib = ReturnType<typeof openObjc>;

function openObjc() {
	// One dlopen per objc_msgSend signature: bun:ffi binds one prototype per symbol.
	const base = dlopen(LIBOBJC, {
		objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
		sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
		objc_autoreleasePoolPush: { args: [], returns: FFIType.ptr },
		objc_autoreleasePoolPop: { args: [FFIType.ptr], returns: FFIType.void },
	});
	const sendPtr = dlopen(LIBOBJC, {
		objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	});
	const sendI64ToPtr = dlopen(LIBOBJC, {
		objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.ptr },
	});
	const sendPtrToPtr = dlopen(LIBOBJC, {
		objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	});
	const sendPtrPtrVoid = dlopen(LIBOBJC, {
		objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	});
	const sendPerform = dlopen(LIBOBJC, {
		objc_msgSend: {
			args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.bool],
			returns: FFIType.void,
		},
	});
	const sendToI64 = dlopen(LIBOBJC, {
		objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
	});
	return { base, sendPtr, sendI64ToPtr, sendPtrToPtr, sendPtrPtrVoid, sendPerform, sendToI64 };
}

let lib: ObjcLib | null = null;
function objc(): ObjcLib {
	if (!lib) lib = openObjc();
	return lib;
}

function cstr(s: string): Buffer {
	return Buffer.from(`${s}\0`, "utf8");
}

const selCache = new Map<string, Pointer>();
function sel(name: string): Pointer {
	let p = selCache.get(name);
	if (!p) {
		p = objc().base.symbols.sel_registerName(cstr(name)) as Pointer;
		selCache.set(name, p);
	}
	return p;
}

function cls(name: string): Pointer {
	const p = objc().base.symbols.objc_getClass(cstr(name)) as Pointer | null;
	if (!p) throw new Error(`objc class ${name} not found`);
	return p;
}

function nsString(s: string): Pointer {
	return objc().sendPtrToPtr.symbols.objc_msgSend(cls("NSString"), sel("stringWithUTF8String:"), cstr(s)) as Pointer;
}

function nsNumber(n: number): Pointer {
	return objc().sendI64ToPtr.symbols.objc_msgSend(cls("NSNumber"), sel("numberWithLongLong:"), n) as Pointer;
}

/**
 * Apply KVC properties to an NSWindow on the main thread (asynchronously).
 * Values are integers; BOOL properties take 0/1.
 */
export function setWindowPropsOnMain(window: Pointer, props: Record<string, number>): void {
	const o = objc();
	const pool = o.base.symbols.objc_autoreleasePoolPush();
	try {
		const dict = o.sendPtr.symbols.objc_msgSend(cls("NSMutableDictionary"), sel("dictionary")) as Pointer;
		for (const [key, value] of Object.entries(props)) {
			o.sendPtrPtrVoid.symbols.objc_msgSend(dict, sel("setObject:forKey:"), nsNumber(value), nsString(key));
		}
		// performSelectorOnMainThread retains both the receiver and the argument
		// until the selector has run, so popping the pool afterwards is safe.
		// waitUntilDone:NO avoids any chance of deadlocking against Electrobun's
		// own worker->main synchronous dispatches.
		o.sendPerform.symbols.objc_msgSend(
			window,
			sel("performSelectorOnMainThread:withObject:waitUntilDone:"),
			sel("setValuesForKeysWithDictionary:"),
			dict,
			false,
		);
	} finally {
		o.base.symbols.objc_autoreleasePoolPop(pool);
	}
}

/** Read an integer-valued property (level, collectionBehavior, ...) for diagnostics. */
export function getWindowIntProp(window: Pointer, getter: string): number {
	return Number(objc().sendToI64.symbols.objc_msgSend(window, sel(getter)));
}

export interface MacOverlayOptions {
	level: number;
	/** Add FullScreenAuxiliary so the window may appear over another app's fullscreen Space. */
	fullScreenAuxiliary: boolean;
}

export function overlayCollectionBehavior(current: number, opts: MacOverlayOptions): number {
	const B = NSWindowCollectionBehavior;
	let behavior = current;
	// Electrobun sets FullScreenPrimary on every window
	// (createNSWindowWithFrameAndStyle). Primary and Auxiliary are mutually
	// exclusive, so strip it.
	behavior &= ~B.FullScreenPrimary;
	behavior &= ~B.MoveToActiveSpace;
	behavior &= ~B.Managed;
	behavior |= B.CanJoinAllSpaces | B.Stationary | B.IgnoresCycle;
	if (opts.fullScreenAuxiliary) behavior |= B.FullScreenAuxiliary;
	return behavior;
}

/** Configure an Electrobun NSWindow as a picker overlay. Returns what was requested. */
export function configureMacOverlayWindow(window: Pointer, opts: MacOverlayOptions): Record<string, number> {
	const before = getWindowIntProp(window, "collectionBehavior");
	const props = {
		level: opts.level,
		collectionBehavior: overlayCollectionBehavior(before, opts),
		hasShadow: 0,
		opaque: 0,
		movable: 0,
		ignoresMouseEvents: 0,
		acceptsMouseMovedEvents: 1,
		// Keep the overlay out of Exposé / window cycling and don't hide it when
		// another app activates (NSWindow default is NO, set explicitly anyway).
		hidesOnDeactivate: 0,
	};
	setWindowPropsOnMain(window, props);
	return { ...props, collectionBehaviorBefore: before };
}

// ---------------------------------------------------------------------------
// CoreGraphics display queries (thread-safe C API, no main-thread hop needed).

type CGLib = ReturnType<typeof openCG>;
function openCG() {
	return dlopen(COREGRAPHICS, {
		CGDisplayPixelsWide: { args: [FFIType.u32], returns: FFIType.u64 },
		CGDisplayPixelsHigh: { args: [FFIType.u32], returns: FFIType.u64 },
		CGDisplayCopyDisplayMode: { args: [FFIType.u32], returns: FFIType.ptr },
		CGDisplayModeGetPixelWidth: { args: [FFIType.ptr], returns: FFIType.u64 },
		CGDisplayModeGetPixelHeight: { args: [FFIType.ptr], returns: FFIType.u64 },
		CGDisplayModeGetWidth: { args: [FFIType.ptr], returns: FFIType.u64 },
		CGDisplayModeGetHeight: { args: [FFIType.ptr], returns: FFIType.u64 },
		CGDisplayModeRelease: { args: [FFIType.ptr], returns: FFIType.void },
		CGDisplayIsBuiltin: { args: [FFIType.u32], returns: FFIType.u32 },
		CGMainDisplayID: { args: [], returns: FFIType.u32 },
	});
}
let cg: CGLib | null = null;

export interface MacDisplayNative {
	displayId: number;
	isMain: boolean;
	isBuiltin: boolean;
	/** CGDisplayPixelsWide/High: the display's size in points per CG (not pixels, despite the name, on Retina). */
	cgPixelsWide: number;
	cgPixelsHigh: number;
	/** Current mode, logical (points). */
	modeWidth: number;
	modeHeight: number;
	/** Current mode, backing-store pixels (what screen capture returns). */
	modePixelWidth: number;
	modePixelHeight: number;
}

export function macDisplayNative(displayId: number): MacDisplayNative | null {
	try {
		if (!cg) cg = openCG();
		const s = cg.symbols;
		const mode = s.CGDisplayCopyDisplayMode(displayId) as Pointer | null;
		const info: MacDisplayNative = {
			displayId,
			isMain: s.CGMainDisplayID() === displayId,
			isBuiltin: s.CGDisplayIsBuiltin(displayId) !== 0,
			cgPixelsWide: Number(s.CGDisplayPixelsWide(displayId)),
			cgPixelsHigh: Number(s.CGDisplayPixelsHigh(displayId)),
			modeWidth: mode ? Number(s.CGDisplayModeGetWidth(mode)) : 0,
			modeHeight: mode ? Number(s.CGDisplayModeGetHeight(mode)) : 0,
			modePixelWidth: mode ? Number(s.CGDisplayModeGetPixelWidth(mode)) : 0,
			modePixelHeight: mode ? Number(s.CGDisplayModeGetPixelHeight(mode)) : 0,
		};
		if (mode) s.CGDisplayModeRelease(mode);
		return info;
	} catch (err) {
		console.warn("[overlay] CoreGraphics query failed", err);
		return null;
	}
}
