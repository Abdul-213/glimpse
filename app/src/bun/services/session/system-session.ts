// OS screen lock / unlock and sleep / wake as a typed app event (GLIM-119). Electrobun
// 2.0.6-beta.2 has no power or session events, so they come from the native helpers
// (native/session.ts). Subscribers get `SystemSessionEvent`s on the Bun worker; nothing
// here throws: without a helper (Linux, a missing library) the source stays silent and
// `status` says why, and Live falls back to noticing a lock through failed captures.
//
// No electrobun or bun:ffi import: tested on Linux with a fake binding.
import type { Logger } from "@glimpse/core";
import type { SessionEventKind, SessionNativeBinding } from "../../native/session.ts";

export interface SystemSessionEvent {
	readonly kind: SessionEventKind;
	/** The native notification it came from ("screenIsLocked", "PBT_APMSUSPEND", ...). */
	readonly source: string;
	/** Epoch ms when it reached the Bun worker. */
	readonly at: number;
}

export type SystemSessionListener = (event: SystemSessionEvent) => void;

export type SystemSessionStatus =
	| { readonly state: "running" }
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "stopped" };

export interface SystemSessionDeps {
	/** Null when the helper is missing (the reason goes in `unavailableReason`). */
	readonly binding: SessionNativeBinding | null;
	readonly unavailableReason?: string;
	readonly log: Logger;
	readonly now?: () => number;
}

export class SystemSession {
	#status: SystemSessionStatus = { state: "stopped" };
	readonly #listeners = new Set<SystemSessionListener>();

	constructor(private readonly deps: SystemSessionDeps) {}

	get status(): SystemSessionStatus {
		return this.#status;
	}

	/** Start listening to the OS. Idempotent; never throws. */
	start(): SystemSessionStatus {
		if (this.#status.state === "running") return this.#status;
		const { binding } = this.deps;
		if (!binding) {
			this.#status = { state: "unavailable", reason: this.deps.unavailableReason ?? "no native helper" };
			this.deps.log.info("system session events unavailable", { reason: this.#status.reason });
			return this.#status;
		}
		try {
			const r = binding.sessionStart((kind, source) => this.#emit(kind, source));
			if (r !== 0) {
				this.#status = { state: "unavailable", reason: `glim_session_start failed (${r})` };
			} else {
				this.#status = { state: "running" };
			}
		} catch (error) {
			this.#status = { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
		}
		const info = this.#status.state === "running" ? safeInfo(binding) : null;
		if (this.#status.state === "running") this.deps.log.info("system session events on", { ...info });
		else this.deps.log.warn("system session events unavailable", { reason: this.#status.reason });
		return this.#status;
	}

	/** Listen; returns the unsubscribe function. */
	subscribe(listener: SystemSessionListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Deliver an event as if the OS had sent it (tests, the headless harness). */
	inject(kind: SessionEventKind, source = "injected"): void {
		this.#emit(kind, source);
	}

	dispose(): void {
		if (this.#status.state === "running") {
			try {
				this.deps.binding?.sessionStop();
			} catch {
				// best effort at quit
			}
		}
		this.#status = { state: "stopped" };
		this.#listeners.clear();
	}

	#emit(kind: SessionEventKind, source: string): void {
		const event: SystemSessionEvent = { kind, source, at: (this.deps.now ?? Date.now)() };
		this.deps.log.info("system session event", { kind, source });
		for (const listener of [...this.#listeners]) {
			try {
				listener(event);
			} catch (error) {
				this.deps.log.warn("system session listener failed", { kind, error });
			}
		}
	}
}

function safeInfo(binding: SessionNativeBinding): Record<string, number> {
	try {
		return binding.sessionInfo() ?? {};
	} catch {
		return {};
	}
}
