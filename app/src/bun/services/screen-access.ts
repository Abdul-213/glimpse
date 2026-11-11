// GLIM-45: the screen-capture permission (macOS Screen Recording) as the app sees it.
//
// The state comes from core's `deriveScreenAccess` over CGPreflightScreenCaptureAccess and
// what Glimpse remembers in settings (`permissions.screenAccess`), because macOS has no
// public API that tells "denied" from "never asked" (spikes/capture/FINDINGS.md). Unsigned
// (ad-hoc signed) builds lose the grant on every update, so "had it, now don't" is its own
// state (`lost`) with its own explanation.
//
// No electrobun imports: the OS calls come in through `ScreenAccessOS`
// (services/screen-access-os.ts builds the real one), so this is tested on Linux.
import {
	canCapture,
	deriveScreenAccess,
	type Logger,
	nextScreenAccessMemory,
	type ScreenAccessMemory,
	type ScreenAccessState,
} from "@glimpse/core";
import type { ScreenAccessStatus } from "../../shared/onboarding-rpc.ts";
import type { TrayNotice } from "../tray-menu.ts";

export interface ScreenAccessOS {
	/** The OS gates capture behind a permission (macOS). */
	readonly required: boolean;
	/** Glimpse runs from an app bundle it can reopen. */
	readonly canRestart: boolean;
	/** CGPreflightScreenCaptureAccess(): never prompts. */
	preflight(): boolean;
	/** CGRequestScreenCaptureAccess(): the system prompt, only while not determined. */
	request(): void;
	/** Open System Settings › Privacy & Security › Screen (& System Audio) Recording. */
	openSettings(): boolean;
	/** Start a helper that reopens Glimpse once this process has exited. */
	scheduleRelaunch(): boolean;
}

export interface ScreenAccessOptions {
	readonly os: ScreenAccessOS;
	readonly memory: () => ScreenAccessMemory;
	readonly saveMemory: (memory: ScreenAccessMemory) => Promise<void>;
	/** Quit Glimpse cleanly (the app.quit command). */
	readonly quit: () => void;
	readonly log?: Logger;
}

export class ScreenAccess {
	readonly #o: ScreenAccessOptions;
	readonly #listeners = new Set<(status: ScreenAccessStatus) => void>();
	#settingsOpened = false;
	#captureDenied = false;
	#last: ScreenAccessStatus | null = null;

	constructor(options: ScreenAccessOptions) {
		this.#o = options;
	}

	/** This OS gates capture behind a permission (onboarding shows the step). */
	get required(): boolean {
		return this.#o.os.required;
	}

	get state(): ScreenAccessState {
		return this.status().state;
	}

	/** Snip and Live can capture other apps. */
	get canCapture(): boolean {
		return canCapture(this.state);
	}

	/** The current status, re-reading preflight. Remembers a grant the first time it is seen. */
	status(): ScreenAccessStatus {
		const { os } = this.#o;
		const preflight = os.required ? os.preflight() : true;
		const memory = this.#o.memory();
		const state = deriveScreenAccess({
			required: os.required,
			preflight,
			memory,
			captureDenied: this.#captureDenied,
		});
		if (os.required && preflight && !this.#captureDenied) this.#remember(memory, { granted: true });
		return { state, settingsOpened: this.#settingsOpened, canRestart: os.canRestart };
	}

	subscribe(listener: (status: ScreenAccessStatus) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Re-check and tell subscribers if anything changed (window focus, a timer). */
	refresh(): ScreenAccessStatus {
		const next = this.status();
		const prev = this.#last;
		this.#last = next;
		if (
			prev &&
			(prev.state !== next.state || prev.settingsOpened !== next.settingsOpened || prev.canRestart !== next.canRestart)
		) {
			this.#o.log?.info("screen access changed", { from: prev.state, to: next.state });
			for (const l of [...this.#listeners]) l(next);
		}
		return next;
	}

	/**
	 * The primary action of the screen-access step. Never asked: show the system prompt (it
	 * has its own "Open System Settings" button). Otherwise the prompt won't show again, so
	 * open System Settings directly.
	 */
	request(): ScreenAccessStatus {
		const { os } = this.#o;
		if (!os.required) return this.refresh();
		const before = this.status();
		if (before.state === "granted") return this.refresh();
		if (before.state === "not-determined") {
			os.request();
			this.#remember(this.#o.memory(), { granted: os.preflight(), requested: true });
			this.#o.log?.info("screen access requested");
		} else {
			this.#open();
		}
		return this.refresh();
	}

	openSettings(): ScreenAccessStatus {
		if (this.#o.os.required) this.#open();
		return this.refresh();
	}

	/** A capture failed with `permission-denied`: access was switched off while running. */
	reportCaptureDenied(): void {
		if (!this.#o.os.required || this.#captureDenied) return;
		this.#captureDenied = true;
		this.#o.log?.warn("capture refused: screen access was turned off");
		this.refresh();
	}

	/** Quit and reopen, so macOS applies a new grant. False if Glimpse can't reopen itself. */
	restart(): boolean {
		if (!this.#o.os.canRestart) return false;
		if (!this.#o.os.scheduleRelaunch()) return false;
		this.#o.log?.info("restarting to apply screen access");
		this.#o.quit();
		return true;
	}

	#open(): void {
		const opened = this.#o.os.openSettings();
		if (opened) this.#settingsOpened = true;
		else this.#o.log?.warn("could not open System Settings");
	}

	#remember(memory: ScreenAccessMemory, observed: { granted: boolean; requested?: boolean }): void {
		const next = nextScreenAccessMemory(memory, observed);
		if (next !== memory) {
			this.#o.saveMemory(next).catch((error) => this.#o.log?.warn("could not save screen access", { error }));
		}
	}
}

/** The tray item while Snip and Live can't capture (macOS without Screen Recording). */
export function screenAccessNotice(state: ScreenAccessState): TrayNotice | null {
	if (canCapture(state)) return null;
	return {
		label: { windows: "Allow screen access…", macos: "Allow Screen Access…" },
		action: "screen-access.open",
	};
}

/** System Settings › Privacy & Security › Screen Recording (macOS 13+; "Screen & System Audio Recording" on 15+). */
export const SCREEN_RECORDING_SETTINGS_URL =
	"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/**
 * The detached helper that reopens Glimpse: wait (up to 10 s) for this process to exit, then
 * `open` the bundle through LaunchServices, so TCC sees a fresh process of the same app.
 */
export function relaunchCommand(bundle: string, pid: number): string[] {
	const script =
		'i=0; while kill -0 "$1" 2>/dev/null && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i+1)); done; exec /usr/bin/open "$2"';
	return ["/bin/sh", "-c", script, "glimpse-relaunch", String(pid), bundle];
}
