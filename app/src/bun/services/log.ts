// GLIM-35: the app's Logger (core port) backed by a rotating file in the per-OS logs dir.
//
//   macOS    ~/Library/Logs/dev.glimpse.app/<channel>/glimpse.log
//   Windows  %LOCALAPPDATA%\dev.glimpse.app\<channel>\glimpse.log
//   Linux    $XDG_STATE_HOME/dev.glimpse.app/<channel>/glimpse.log (dev only)
//
// (the composition root passes Electrobun's `Utils.paths.userLogs`). Files rotate at
// `maxBytes` into glimpse.1.log ... glimpse.<keep-1>.log, so the logs never grow past
// about keep x maxBytes (5 MiB by default). Nothing is ever sent anywhere (no telemetry).
//
// Writes are synchronous appends: a record is on disk before the next line of code runs, so
// the log survives a crash right after it, and ordering is trivially right. Glimpse logs a
// few lines per user action, not per frame, so the cost is negligible on the Bun worker.
// A failing disk never throws into callers: the sink drops lines and counts them.
//
// Privacy: records arrive already redacted (core `Redactor`): no API keys, no screen text
// (unless GLIMPSE_LOG_SCREEN_TEXT=1 for a debugging session), never pixels.
//
// No electrobun imports, so this is unit-tested on Linux with a temp dir.

import { closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	createLogger,
	formatLogRecord,
	isLogLevel,
	type LogLevel,
	type LogRecord,
	type LogSink,
	Redactor,
	type RootLogger,
} from "@glimpse/core";

export const LOG_FILE = "glimpse.log";

export interface RotatingFileSinkOptions {
	/** Rotate when the current file would pass this many bytes. Default 1 MiB. */
	readonly maxBytes?: number;
	/** Files kept, the current one included. Default 5. */
	readonly keep?: number;
	/** Lines kept in memory for `recent()`. Default 300. */
	readonly memoryLines?: number;
}

/** `glimpse.log`, `glimpse.1.log`, ... */
export const rotatedName = (index: number): string => (index === 0 ? LOG_FILE : `glimpse.${index}.log`);

export class RotatingFileSink implements LogSink {
	readonly dir: string;
	readonly path: string;
	readonly #maxBytes: number;
	readonly #keep: number;
	readonly #memoryLines: number;
	readonly #recent: string[] = [];
	#fd: number | null = null;
	#size = 0;
	#dropped = 0;

	constructor(dir: string, options: RotatingFileSinkOptions = {}) {
		this.dir = dir;
		this.path = join(dir, LOG_FILE);
		this.#maxBytes = Math.max(1024, options.maxBytes ?? 1024 * 1024);
		this.#keep = Math.max(1, options.keep ?? 5);
		this.#memoryLines = options.memoryLines ?? 300;
	}

	/** Lines that could not be written (disk full, permissions) since start. */
	get dropped(): number {
		return this.#dropped;
	}

	write(record: LogRecord): void {
		const line = `${formatLogRecord(record)}\n`;
		this.#remember(line.trimEnd());
		const bytes = Buffer.byteLength(line);
		try {
			this.#open();
			if (this.#size > 0 && this.#size + bytes > this.#maxBytes) this.#rotate();
			const fd = this.#open();
			writeSync(fd, line);
			this.#size += bytes;
		} catch {
			this.#dropped++;
			this.#closeQuietly();
		}
	}

	/** The newest lines written this session (oldest first). */
	recent(count = this.#memoryLines): string[] {
		return this.#recent.slice(-count);
	}

	/**
	 * The newest `count` lines on disk, across rotated files (includes the previous session, which
	 * matters after a crash). Reads at most `maxBytes` per file.
	 */
	tail(count = 200): string[] {
		const lines: string[] = [];
		for (let i = 0; i < this.#keep && lines.length < count; i++) {
			const text = readEnd(join(this.dir, rotatedName(i)), 256 * 1024);
			if (text === null) break;
			const fileLines = text.split("\n").filter(Boolean);
			lines.unshift(...fileLines.slice(-(count - lines.length)));
		}
		return lines;
	}

	close(): void {
		this.#closeQuietly();
	}

	#remember(line: string): void {
		this.#recent.push(line);
		if (this.#recent.length > this.#memoryLines) this.#recent.splice(0, this.#recent.length - this.#memoryLines);
	}

	#open(): number {
		if (this.#fd !== null) return this.#fd;
		mkdirSync(this.dir, { recursive: true });
		this.#fd = openSync(this.path, "a", 0o600);
		try {
			this.#size = statSync(this.path).size;
		} catch {
			this.#size = 0;
		}
		return this.#fd;
	}

	#rotate(): void {
		this.#closeQuietly();
		rmSync(join(this.dir, rotatedName(this.#keep - 1)), { force: true });
		for (let i = this.#keep - 2; i >= 0; i--) {
			try {
				renameSync(join(this.dir, rotatedName(i)), join(this.dir, rotatedName(i + 1)));
			} catch {
				// Missing file, or (Windows) briefly locked by an indexer: skip it.
			}
		}
		// keep = 1: the rename loop doesn't run; start the file over.
		if (this.#keep === 1) rmSync(this.path, { force: true });
		this.#size = 0;
	}

	#closeQuietly(): void {
		if (this.#fd === null) return;
		try {
			closeSync(this.#fd);
		} catch {
			// already closed
		}
		this.#fd = null;
	}
}

function readEnd(path: string, maxBytes: number): string | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const size = statSync(path).size;
		const length = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		let text = buffer.toString("utf8");
		// Drop a partial first line when we started mid-file.
		if (length < size) text = text.slice(text.indexOf("\n") + 1);
		return text;
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

/** Mirrors records to the console (`electrobun dev` shows it). */
export class ConsoleSink implements LogSink {
	write(record: LogRecord): void {
		const line = formatLogRecord(record);
		if (record.level === "error") console.error(line);
		else if (record.level === "warn") console.warn(line);
		else console.log(line);
	}
}

export interface LogEnvOverrides {
	/** `GLIMPSE_LOG_LEVEL`: error | warn | info | debug. Wins over the setting for this run. */
	readonly level: LogLevel | null;
	/** `GLIMPSE_LOG_SCREEN_TEXT=1`: log OCR and translation text verbatim. Developer use only. */
	readonly screenText: boolean;
}

export function logEnvOverrides(env: Readonly<Record<string, string | undefined>>): LogEnvOverrides {
	const level = env["GLIMPSE_LOG_LEVEL"]?.trim().toLowerCase();
	return {
		level: isLogLevel(level) ? level : null,
		screenText: env["GLIMPSE_LOG_SCREEN_TEXT"] === "1",
	};
}

export interface AppLoggerOptions {
	/** Logs directory (`Utils.paths.userLogs`). */
	readonly dir: string;
	/** Initial level, before settings are loaded. Default `info`. */
	readonly level?: LogLevel;
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Also print to the console. Default true. */
	readonly console?: boolean;
	readonly homeDir?: string;
	readonly file?: RotatingFileSinkOptions;
}

export interface AppLogger {
	readonly logger: RootLogger;
	readonly file: RotatingFileSink;
	readonly overrides: LogEnvOverrides;
	/** Apply the level from settings, unless the environment overrides it. */
	applySettingsLevel(level: LogLevel): void;
}

export function createAppLogger(options: AppLoggerOptions): AppLogger {
	const overrides = logEnvOverrides(options.env ?? process.env);
	const file = new RotatingFileSink(options.dir, options.file);
	const redactor = new Redactor({ includeContent: overrides.screenText, homeDir: options.homeDir ?? homedir() });
	const logger = createLogger({
		sinks: options.console === false ? [file] : [file, new ConsoleSink()],
		level: overrides.level ?? options.level ?? "info",
		redactor,
	});
	if (overrides.screenText) {
		logger.warn("screen text logging is on (GLIMPSE_LOG_SCREEN_TEXT=1); logs will contain OCR and translation text");
	}
	return {
		logger,
		file,
		overrides,
		applySettingsLevel: (level) => {
			if (!overrides.level) logger.setLevel(level);
		},
	};
}
