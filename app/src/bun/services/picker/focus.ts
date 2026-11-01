// FocusKeeper over the native helpers (GLIM-91, region-picker spec 7). Never throws:
// a refused restore is logged and the picker carries on.
import type { FocusKeeper } from "@glimpse/core";

/** The two calls both helpers export (glim_focus_save / glim_focus_restore). */
export interface FocusBinding {
	focusSave(): number;
	focusRestore(): boolean;
}

export class NativeFocusKeeper implements FocusKeeper {
	constructor(
		private readonly binding: FocusBinding,
		private readonly log: (message: string) => void = () => {},
	) {}

	save(): void {
		try {
			this.binding.focusSave();
		} catch (e) {
			this.log(`focus save failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	restore(): boolean {
		try {
			return this.binding.focusRestore();
		} catch (e) {
			this.log(`focus restore failed: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
	}
}

/** Linux / no helper: nothing to save or restore. */
export class NoFocusKeeper implements FocusKeeper {
	save(): void {}
	restore(): boolean {
		return false;
	}
}
