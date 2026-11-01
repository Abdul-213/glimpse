// macOS hotkey backend: Carbon RegisterEventHotKey through libglimpse.dylib (hotkey.m).
// No electrobun import; the binding is faked in tests.
import type { Hotkey } from "@glimpse/core";
import type { MacHotkeyBinding } from "../native/macos.ts";
import { describeOSStatus, toCarbon } from "./hotkey-keys.ts";
import type { HotkeyBackend, RegisterResult } from "./hotkeys.ts";

export class CarbonHotkeyBackend implements HotkeyBackend {
	readonly name = "carbon";
	private readonly ids = new Map<Hotkey, number>();
	private readonly handlers = new Map<number, () => void>();
	private nextId = 0;
	private ready: number | null = null;

	constructor(private readonly binding: MacHotkeyBinding) {}

	private init(): number {
		this.ready ??= this.binding.hotkeyInit((id) => this.handlers.get(id)?.());
		return this.ready;
	}

	register(hotkey: Hotkey, onPress: () => void): RegisterResult {
		const init = this.init();
		if (init !== 0) return { ok: false, detail: `InstallEventHandler failed: ${describeOSStatus(init)}` };
		const code = toCarbon(hotkey);
		if (!code) return { ok: false, detail: `${hotkey} has no Carbon key code` };
		const id = this.ids.get(hotkey) ?? this.nextId++;
		const status = this.binding.hotkeyRegister(id, code.keyCode, code.mods);
		if (status !== 0) return { ok: false, detail: describeOSStatus(status) };
		this.ids.set(hotkey, id);
		this.handlers.set(id, onPress);
		return { ok: true, detail: `RegisterEventHotKey(0x${code.keyCode.toString(16)}, 0x${code.mods.toString(16)})` };
	}

	unregister(hotkey: Hotkey): void {
		const id = this.ids.get(hotkey);
		if (id === undefined) return;
		this.binding.hotkeyUnregister(id);
		this.ids.delete(hotkey);
		this.handlers.delete(id);
	}

	dispose(): void {
		this.binding.hotkeyShutdown();
		this.ids.clear();
		this.handlers.clear();
		this.ready = null;
	}
}
