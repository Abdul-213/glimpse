// Global hotkeys (GLIM-44, decision GLIM-23, spikes/hotkeys). Registers the Snip and Live
// bindings from settings with one backend per OS:
//
//   Windows  Electrobun GlobalShortcut (RegisterHotKey + MOD_NOREPEAT): consumes the key,
//            reports conflicts as `false`           -> hotkeys-electrobun.ts
//   macOS    Carbon RegisterEventHotKey in libglimpse.dylib: no Accessibility prompt,
//            consumes the key, OSStatus on conflict -> hotkeys-carbon.ts
//   Linux    none (dev/CI target; the tray works without hotkeys)
//
// A failed registration is never silently rebound (GLIM-23 "Registration failure
// handling"): the action is reported as `conflict` and logged; the tray items always work.
// The conflict badge / notification UI is not built yet (Settings, GLIM-69). No electrobun import here: tested on
// Linux with a fake backend.
import type { Hotkey, HotkeyAction, HotkeyBindings, Logger } from "@glimpse/core";

export interface RegisterResult {
	readonly ok: boolean;
	readonly detail: string;
}

export interface HotkeyBackend {
	readonly name: string;
	register(hotkey: Hotkey, onPress: () => void): RegisterResult;
	unregister(hotkey: Hotkey): void;
	dispose(): void;
}

export type HotkeyState = "registered" | "conflict" | "unbound" | "unavailable";

export interface HotkeyStatus {
	readonly action: HotkeyAction;
	readonly hotkey: Hotkey | null;
	readonly state: HotkeyState;
	readonly detail: string;
}

export class HotkeyService {
	private readonly registered = new Map<HotkeyAction, Hotkey>();
	private statuses: HotkeyStatus[] = [];

	constructor(
		private readonly backend: HotkeyBackend | null,
		private readonly log: Logger,
		/** Why there is no backend (diagnostics), when `backend` is null. */
		private readonly unavailableReason = "no hotkey backend on this platform",
	) {}

	get backendName(): string {
		return this.backend?.name ?? "none";
	}

	/** Current status per bound action (diagnostics, Settings, onboarding). */
	status(): readonly HotkeyStatus[] {
		return this.statuses;
	}

	/**
	 * Register `bindings` for the actions that have a handler; unregister what is no longer
	 * bound. Safe to call again after a settings change.
	 */
	apply(bindings: HotkeyBindings, handlers: Partial<Record<HotkeyAction, () => void>>): readonly HotkeyStatus[] {
		for (const [action, hotkey] of this.registered) {
			this.backend?.unregister(hotkey);
			this.registered.delete(action);
		}
		const out: HotkeyStatus[] = [];
		for (const action of Object.keys(handlers) as HotkeyAction[]) {
			const handler = handlers[action];
			const hotkey = bindings[action];
			if (!handler) continue;
			if (!hotkey) {
				out.push({ action, hotkey: null, state: "unbound", detail: "no shortcut set" });
				continue;
			}
			if (!this.backend) {
				out.push({ action, hotkey, state: "unavailable", detail: this.unavailableReason });
				continue;
			}
			let result: RegisterResult;
			try {
				result = this.backend.register(hotkey, handler);
			} catch (e) {
				result = { ok: false, detail: e instanceof Error ? e.message : String(e) };
			}
			if (result.ok) this.registered.set(action, hotkey);
			else this.log.warn("hotkey not registered", { action, hotkey, detail: result.detail });
			out.push({ action, hotkey, state: result.ok ? "registered" : "conflict", detail: result.detail });
		}
		this.statuses = out;
		this.log.info("hotkeys", {
			backend: this.backendName,
			...Object.fromEntries(out.map((s) => [s.action, `${s.hotkey ?? "-"} ${s.state}`])),
		});
		return out;
	}

	dispose(): void {
		for (const hotkey of this.registered.values()) this.backend?.unregister(hotkey);
		this.registered.clear();
		this.backend?.dispose();
	}
}
