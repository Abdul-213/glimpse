// GLIM-35: the Logger port. Core and providers log through this interface; the app
// implements it with a rotating file in the per-OS logs dir (app/src/bun/services/log.ts),
// tests use `MemoryLogSink` from @glimpse/core/testing.
//
// Privacy (PRODUCT.md "Private by default, honest always"): logs stay on the device (no
// telemetry), and by default never contain API keys, screen text or pixels. Every record
// goes through a `Redactor` (redact.ts) before it reaches a sink, so call sites don't have
// to be perfect. Still: put screen text only in `sensitive(...)` and never log a key value.

export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Readonly<Record<LogLevel, number>> = { error: 0, warn: 1, info: 2, debug: 3 };

/** True when a record at `level` passes a logger set to `threshold`. */
export const levelEnabled = (threshold: LogLevel, level: LogLevel): boolean => RANK[level] <= RANK[threshold];

export const isLogLevel = (value: unknown): value is LogLevel =>
	typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);

/** Structured fields. Values can be anything; the redactor turns them into safe JSON. */
export type LogFields = Readonly<Record<string, unknown>>;

/** A record after redaction: plain JSON values only. What sinks receive. */
export interface LogRecord {
	/** Epoch ms. */
	readonly time: number;
	readonly level: LogLevel;
	/** Dotted component name, e.g. `settings`, `providers.bergamot`. Empty for the root. */
	readonly scope: string;
	readonly message: string;
	readonly fields: Readonly<Record<string, JsonLogValue>>;
}

export type JsonLogValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonLogValue[]
	| { readonly [key: string]: JsonLogValue };

export interface LogSink {
	write(record: LogRecord): void;
}

export interface Logger {
	/** Current threshold (shared by a root logger and all its children). */
	readonly level: LogLevel;
	/** Check before building expensive fields. */
	enabled(level: LogLevel): boolean;
	error(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	info(message: string, fields?: LogFields): void;
	debug(message: string, fields?: LogFields): void;
	/** A logger for a component: `scope` is appended (`a` + `b` = `a.b`), `fields` are added to every record. */
	child(scope: string, fields?: LogFields): Logger;
}
