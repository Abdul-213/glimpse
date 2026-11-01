// Two hotkey backends behind one interface.
//   A. "electrobun": Electrobun's GlobalShortcut (RegisterHotKey on Windows,
//      NSEvent addGlobalMonitorForEvents on macOS, XGrabKey on Linux).
//   B. "carbon": macOS only. Carbon RegisterEventHotKey through
//      native/macos/glimhotkey.c, loaded with bun:ffi.
import { GlobalShortcut, PATHS } from "electrobun/main";
import { dlopen, FFIType, JSCallback, suffix } from "bun:ffi";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	type BackendName,
	type HotkeyDef,
	type Platform,
	describeOSStatus,
	parseAccelerator,
	toCarbon,
	toElectrobunAccelerator,
} from "../shared/hotkeys";

export interface RegisterResult {
	ok: boolean;
	detail: string;
}

export interface HotkeyBackend {
	readonly name: BackendName;
	register(def: HotkeyDef, onPress: () => void): RegisterResult;
	unregisterAll(): void;
	diagnostics(): string[];
	dispose(): void;
}

// ---- macOS diagnostics without the dylib (used by backend A) --------------

let axTrusted: (() => boolean) | null = null;
function macAccessibilityTrusted(): boolean | null {
	if (process.platform !== "darwin") return null;
	try {
		if (!axTrusted) {
			const lib = dlopen(
				"/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
				{ AXIsProcessTrusted: { args: [], returns: FFIType.bool } },
			);
			axTrusted = () => lib.symbols.AXIsProcessTrusted() as boolean;
		}
		return axTrusted();
	} catch (err) {
		console.warn("[spike] AXIsProcessTrusted lookup failed:", err);
		return null;
	}
}

// ---- A. Electrobun GlobalShortcut ------------------------------------------

export class ElectrobunBackend implements HotkeyBackend {
	readonly name = "electrobun" as const;
	private registered: string[] = [];

	constructor(private readonly platform: Platform) {}

	register(def: HotkeyDef, onPress: () => void): RegisterResult {
		const accel = toElectrobunAccelerator(parseAccelerator(def.accelerator));
		const ok = GlobalShortcut.register(accel, onPress);
		if (ok) this.registered.push(accel);
		let detail: string;
		if (this.platform === "darwin") {
			const ax = macAccessibilityTrusted();
			detail = ok
				? `GlobalShortcut.register -> true (NSEvent monitor; Accessibility trusted: ${ax}). ` +
					(ax === false
						? "NOT TRUSTED: the monitor exists but will never see key events."
						: "true does not mean the chord is free: NSEvent cannot detect conflicts.")
				: "GlobalShortcut.register -> false (only happens for an unknown key or a duplicate in this process)";
		} else if (this.platform === "win32") {
			detail = ok
				? "GlobalShortcut.register -> true (RegisterHotKey succeeded)"
				: "GlobalShortcut.register -> false (RegisterHotKey failed; Electrobun only logs the Win32 error, 1409 = held by another app)";
		} else {
			detail = `GlobalShortcut.register -> ${ok} (XGrabKey; Electrobun cannot detect X11 BadAccess)`;
		}
		return { ok, detail };
	}

	unregisterAll(): void {
		GlobalShortcut.unregisterAll();
		this.registered = [];
	}

	diagnostics(): string[] {
		const out = [
			`Registered via Electrobun: ${this.registered.join(", ") || "(none)"}`,
			...this.registered.map((a) => `isRegistered(${a}) = ${GlobalShortcut.isRegistered(a)}`),
		];
		if (this.platform === "darwin") out.push(`AXIsProcessTrusted() = ${macAccessibilityTrusted()}`);
		return out;
	}

	dispose(): void {
		this.unregisterAll();
	}
}

// ---- B. Carbon RegisterEventHotKey via dylib --------------------------------

const DYLIB_NAME = `libglimhotkey.${suffix}`;

export function carbonDylibCandidates(): string[] {
	const out: string[] = [];
	if (process.env.GLIM_HOTKEY_DYLIB) out.push(process.env.GLIM_HOTKEY_DYLIB);
	// Packaged app: build.copy puts it at <Resources>/app/native/.
	try {
		out.push(resolve(PATHS.RESOURCES_FOLDER, "app/native", DYLIB_NAME));
	} catch {
		// PATHS may not resolve outside a bundle
	}
	out.push(resolve(import.meta.dir, "../native", DYLIB_NAME));
	out.push(resolve(process.cwd(), "native/macos/build", DYLIB_NAME));
	return out;
}

function openCarbonLib(path: string) {
	return dlopen(path, {
		glim_hk_init: { args: [FFIType.function], returns: FFIType.i32 },
		glim_hk_register: {
			args: [FFIType.i32, FFIType.u32, FFIType.u32, FFIType.u32],
			returns: FFIType.i32,
		},
		glim_hk_unregister: { args: [FFIType.i32], returns: FFIType.i32 },
		glim_hk_unregister_all: { args: [], returns: FFIType.i32 },
		glim_hk_shutdown: { args: [], returns: FFIType.i32 },
		glim_hk_exclusive_flag: { args: [], returns: FFIType.i32 },
		glim_ax_trusted: { args: [], returns: FFIType.i32 },
		glim_secure_input: { args: [], returns: FFIType.i32 },
	});
}

export class CarbonBackend implements HotkeyBackend {
	readonly name = "carbon" as const;
	private lib: ReturnType<typeof openCarbonLib>;
	private cb: JSCallback;
	private handlers = new Map<number, () => void>();
	private nextId = 0;
	private readonly exclusive: number;
	readonly path: string;

	/** Throws if the dylib is missing or the handler cannot be installed. */
	constructor() {
		if (process.platform !== "darwin") throw new Error("Carbon backend is macOS-only");
		const path = carbonDylibCandidates().find((p) => existsSync(p));
		if (!path) {
			throw new Error(
				`libglimhotkey.dylib not found (run \`bun run native:mac\` before building). Looked in:\n  ${carbonDylibCandidates().join("\n  ")}`,
			);
		}
		this.path = path;
		this.lib = openCarbonLib(path);
		// Called on the macOS main thread; threadsafe queues it onto this worker.
		this.cb = new JSCallback(
			(id: number, kind: number) => {
				if (kind !== 1) return; // ignore key-up
				this.handlers.get(id)?.();
			},
			{ args: [FFIType.i32, FFIType.i32], returns: FFIType.void, threadsafe: true },
		);
		const st = this.lib.symbols.glim_hk_init(this.cb);
		if (st !== 0) throw new Error(`InstallEventHandler failed: ${describeOSStatus(st)}`);
		this.exclusive = this.lib.symbols.glim_hk_exclusive_flag();
	}

	register(def: HotkeyDef, onPress: () => void): RegisterResult {
		const { keyCode, mods } = toCarbon(parseAccelerator(def.accelerator));
		const id = this.nextId++;
		// Exclusive: fail with eventHotKeyExistsErr if another app already holds it.
		const st = this.lib.symbols.glim_hk_register(id, keyCode, mods, this.exclusive);
		if (st === 0) this.handlers.set(id, onPress);
		return {
			ok: st === 0,
			detail: `RegisterEventHotKey(keyCode=0x${keyCode.toString(16)}, mods=0x${mods.toString(16)}, exclusive) -> ${describeOSStatus(st)}`,
		};
	}

	unregisterAll(): void {
		this.lib.symbols.glim_hk_unregister_all();
		this.handlers.clear();
	}

	diagnostics(): string[] {
		return [
			`dylib: ${this.path}`,
			`Carbon hot keys registered: ${this.handlers.size}`,
			`AXIsProcessTrusted() = ${this.lib.symbols.glim_ax_trusted() === 1} (Carbon does not need it)`,
			`IsSecureEventInputEnabled() = ${this.lib.symbols.glim_secure_input() === 1}`,
		];
	}

	dispose(): void {
		this.lib.symbols.glim_hk_shutdown();
		this.handlers.clear();
		this.cb.close();
		this.lib.close();
	}
}

export function createBackend(name: BackendName, platform: Platform): HotkeyBackend {
	return name === "carbon" ? new CarbonBackend() : new ElectrobunBackend(platform);
}
