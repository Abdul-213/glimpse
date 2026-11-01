// GLIM-35: the Logger implementation shared by the app and tests. Pure: records are
// redacted here, then handed to injected sinks (file, console, memory).

import { Redactor } from "./redact.ts";
import { type LogFields, type Logger, type LogLevel, type LogRecord, type LogSink, levelEnabled } from "./types.ts";

export interface LoggerOptions {
	readonly sinks: readonly LogSink[];
	readonly level?: LogLevel;
	readonly redactor?: Redactor;
	/** Epoch ms (tests pass a fixed clock). */
	readonly now?: () => number;
}

/** A root logger whose level can change at runtime (Settings > diagnostics). Children follow it. */
export interface RootLogger extends Logger {
	setLevel(level: LogLevel): void;
	readonly redactor: Redactor;
}

interface Shared {
	level: LogLevel;
	readonly sinks: readonly LogSink[];
	readonly redactor: Redactor;
	readonly now: () => number;
}

class ScopedLogger implements Logger {
	constructor(
		protected readonly shared: Shared,
		private readonly scope: string,
		private readonly base: LogFields,
	) {}

	get level(): LogLevel {
		return this.shared.level;
	}

	enabled(level: LogLevel): boolean {
		return levelEnabled(this.shared.level, level);
	}

	error(message: string, fields?: LogFields): void {
		this.#log("error", message, fields);
	}
	warn(message: string, fields?: LogFields): void {
		this.#log("warn", message, fields);
	}
	info(message: string, fields?: LogFields): void {
		this.#log("info", message, fields);
	}
	debug(message: string, fields?: LogFields): void {
		this.#log("debug", message, fields);
	}

	child(scope: string, fields?: LogFields): Logger {
		const name = this.scope && scope ? `${this.scope}.${scope}` : this.scope || scope;
		return new ScopedLogger(this.shared, name, fields ? { ...this.base, ...fields } : this.base);
	}

	#log(level: LogLevel, message: string, fields: LogFields | undefined): void {
		if (!levelEnabled(this.shared.level, level)) return;
		const { redactor } = this.shared;
		let record: LogRecord;
		try {
			record = {
				time: this.shared.now(),
				level,
				scope: this.scope,
				message: redactor.string(message),
				fields: redactor.fields(fields ? { ...this.base, ...fields } : this.base),
			};
		} catch (error) {
			// A getter that throws, a hostile proxy... Logging must never take the app down.
			record = {
				time: this.shared.now(),
				level,
				scope: this.scope,
				message: redactor.string(message),
				fields: { logError: redactor.string(String(error)) },
			};
		}
		for (const sink of this.shared.sinks) {
			try {
				sink.write(record);
			} catch {
				// A broken sink (disk full) must not break the others or the caller.
			}
		}
	}
}

class Root extends ScopedLogger implements RootLogger {
	setLevel(level: LogLevel): void {
		this.shared.level = level;
	}
	get redactor(): Redactor {
		return this.shared.redactor;
	}
}

export function createLogger(options: LoggerOptions): RootLogger {
	return new Root(
		{
			level: options.level ?? "info",
			sinks: options.sinks,
			redactor: options.redactor ?? new Redactor(),
			now: options.now ?? Date.now,
		},
		"",
		{},
	);
}

/** Discards everything. For code paths that have no logger yet. */
export const nullLogger: Logger = {
	level: "error",
	enabled: () => false,
	error: () => {},
	warn: () => {},
	info: () => {},
	debug: () => {},
	child: () => nullLogger,
};
