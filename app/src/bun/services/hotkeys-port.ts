// The contract between Settings and the hotkey service (GLIM-23, GLIM-44: services/hotkeys.ts).
// Settings never registers shortcuts itself: it asks the registrar to apply a set of bindings
// and shows what the OS said, per action.
//
// `ServiceHotkeyRegistrar` adapts `HotkeyService` (Electrobun GlobalShortcut on Windows,
// Carbon on macOS, none on Linux) to this port: it keeps the actions' handlers, so a
// re-apply after a settings change registers the same callbacks.
//
// No electrobun imports: tested on Linux with a fake backend.
import type { HotkeyAction, HotkeyBindings } from "@glimpse/core";
import type { HotkeyRegistration, HotkeyStatus } from "../../shared/settings-rpc.ts";
import type { HotkeyService, HotkeyStatus as ServiceStatus } from "./hotkeys.ts";

export const HOTKEY_ACTIONS: readonly HotkeyAction[] = ["snip", "live", "pauseLive", "resnip", "toggleLivePopup"];

export interface HotkeyRegistrar {
	/** What the OS said about each action at the last `apply`. */
	status(): HotkeyStatus;
	/**
	 * Register exactly these bindings, replacing the previous ones. Resolves with the outcome
	 * per action; an action whose registration failed is left unregistered (never silently
	 * rebound). Must not throw for an OS refusal: that is a `failed` status.
	 */
	apply(bindings: HotkeyBindings): Promise<HotkeyStatus>;
	/** Status changes the registrar notices on its own. */
	subscribe(listener: (status: HotkeyStatus) => void): () => void;
}

export type HotkeyHandlers = Partial<Record<HotkeyAction, () => void>>;

/** Words for the Settings view; the backend's detail (Win32 error, OSStatus) stays in the log. */
const IN_USE = "Another app or the system already uses this shortcut. Choose a different one.";
const UNAVAILABLE = "Global shortcuts aren't available on this system. Use the tray menu instead.";

/**
 * Per-action status for Settings from the service's report. Actions with no handler (features
 * that don't exist yet) aren't registered: a binding for one is `inactive`, not an error.
 */
export function registrationStatus(
	bindings: HotkeyBindings,
	reported: readonly ServiceStatus[],
	handlers: HotkeyHandlers,
): HotkeyStatus {
	const one = (action: HotkeyAction): HotkeyRegistration => {
		if (bindings[action] === null) return { state: "unbound" };
		if (!handlers[action]) return { state: "inactive" };
		const r = reported.find((s) => s.action === action);
		switch (r?.state) {
			case "registered":
				return { state: "ready" };
			case "conflict":
				return { state: "failed", reason: "in-use", message: IN_USE };
			case "unavailable":
				return { state: "failed", reason: "unavailable", message: UNAVAILABLE };
			default:
				// Not applied yet.
				return { state: "unbound" };
		}
	};
	return {
		snip: one("snip"),
		live: one("live"),
		pauseLive: one("pauseLive"),
		resnip: one("resnip"),
		toggleLivePopup: one("toggleLivePopup"),
	};
}

export class ServiceHotkeyRegistrar implements HotkeyRegistrar {
	#status: HotkeyStatus;
	readonly #listeners = new Set<(status: HotkeyStatus) => void>();

	constructor(
		private readonly service: Pick<HotkeyService, "apply">,
		private readonly handlers: HotkeyHandlers,
	) {
		this.#status = registrationStatus(
			{ snip: null, live: null, pauseLive: null, resnip: null, toggleLivePopup: null },
			[],
			handlers,
		);
	}

	status(): HotkeyStatus {
		return this.#status;
	}

	async apply(bindings: HotkeyBindings): Promise<HotkeyStatus> {
		const reported = this.service.apply(bindings, this.handlers);
		this.#status = registrationStatus(bindings, reported, this.handlers);
		for (const l of [...this.#listeners]) l(this.#status);
		return this.#status;
	}

	subscribe(listener: (status: HotkeyStatus) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}
