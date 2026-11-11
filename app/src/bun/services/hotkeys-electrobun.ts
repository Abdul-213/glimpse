// Windows hotkey backend: Electrobun's GlobalShortcut, which is RegisterHotKey with
// MOD_NOREPEAT on a dedicated message thread (spikes/hotkeys/FINDINGS.md). It returns only
// a boolean; Electrobun logs the Win32 error (1409 = held by another app).
// Imports electrobun/main, so it isn't unit-tested; the logic is in hotkeys.ts.
import type { Hotkey } from "@glimpse/core";
import { GlobalShortcut } from "electrobun/main";
import { toElectrobunAccelerator } from "./hotkey-keys.ts";
import type { HotkeyBackend, RegisterResult } from "./hotkeys.ts";

export class ElectrobunHotkeyBackend implements HotkeyBackend {
	readonly name = "electrobun";
	private readonly accelerators = new Map<Hotkey, string>();

	register(hotkey: Hotkey, onPress: () => void): RegisterResult {
		const accel = toElectrobunAccelerator(hotkey);
		if (!accel) return { ok: false, detail: `${hotkey} is not a valid shortcut` };
		const ok = GlobalShortcut.register(accel, onPress);
		if (ok) this.accelerators.set(hotkey, accel);
		return {
			ok,
			detail: ok ? `RegisterHotKey(${accel})` : `RegisterHotKey(${accel}) failed: probably held by another app`,
		};
	}

	unregister(hotkey: Hotkey): void {
		const accel = this.accelerators.get(hotkey);
		if (!accel) return;
		GlobalShortcut.unregister(accel);
		this.accelerators.delete(hotkey);
	}

	dispose(): void {
		for (const accel of this.accelerators.values()) GlobalShortcut.unregister(accel);
		this.accelerators.clear();
	}
}
