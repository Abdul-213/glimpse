// GLIM-41: the app command bus. Every user intent that more than one surface can trigger
// (tray, hotkeys, popups, Settings) is a command; surfaces dispatch, features handle. Each
// command has exactly one handler, registered by the feature that owns it (Snip GLIM-48,
// Live GLIM-56, cache GLIM-67...). Until then the composition root registers stubs.
//
// No electrobun imports: tested on Linux.

import type { Logger } from "@glimpse/core";

export const COMMANDS = [
	"snip.start",
	"live.start",
	"live.stop",
	"live.pause",
	"live.resume",
	/** Hide / show the docked Live popup (live-popup.md L19); the session keeps running. */
	"live.popup.toggle",
	/** "Focus Live popup" (§6.3): keyboard and screen-reader users reach its controls. */
	"live.popup.focus",
	"private.toggle",
	/** GLIM-158: Show translations on screen (the Settings default; a running Live session follows). */
	"overlay.toggle",
	"cache.clear",
	"settings.open",
	"screen-access.open",
	"onboarding.open",
	"diagnostics.copy",
	"logs.open",
	"update.open",
	"app.quit",
] as const;

export type Command = (typeof COMMANDS)[number];

export const isCommand = (value: unknown): value is Command =>
	typeof value === "string" && (COMMANDS as readonly string[]).includes(value);

/** Where a command came from, for logs (and later, focus rules: tray clicks activate Glimpse). */
export type CommandSource = "tray" | "hotkey" | "popup" | "settings" | "internal";

export type CommandHandler = (source: CommandSource) => void | Promise<void>;

export class CommandBus {
	readonly #handlers = new Map<Command, CommandHandler>();
	readonly #log: Logger;

	constructor(log: Logger) {
		this.#log = log;
	}

	/** Register the one handler for a command. Returns an unregister function. */
	handle(command: Command, handler: CommandHandler): () => void {
		if (this.#handlers.has(command)) throw new Error(`command ${command} already has a handler`);
		this.#handlers.set(command, handler);
		return () => {
			if (this.#handlers.get(command) === handler) this.#handlers.delete(command);
		};
	}

	has(command: Command): boolean {
		return this.#handlers.has(command);
	}

	/** Run a command. Never throws: a failing handler is logged, so a tray click can't crash the app. */
	async dispatch(command: Command, source: CommandSource = "internal"): Promise<boolean> {
		const handler = this.#handlers.get(command);
		if (!handler) {
			this.#log.warn("no handler for command", { command, source });
			return false;
		}
		this.#log.debug("command", { command, source });
		try {
			await handler(source);
			return true;
		} catch (error) {
			this.#log.error("command failed", { command, source, error });
			return false;
		}
	}
}
