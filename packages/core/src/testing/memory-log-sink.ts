// A LogSink that keeps records in memory, for asserting what was logged (and what wasn't).

import { formatLogRecord } from "../logging/format.ts";
import type { LogLevel, LogRecord, LogSink } from "../logging/types.ts";

export class MemoryLogSink implements LogSink {
	readonly records: LogRecord[] = [];

	write(record: LogRecord): void {
		this.records.push(record);
	}

	/** Records at one level. */
	at(level: LogLevel): LogRecord[] {
		return this.records.filter((r) => r.level === level);
	}

	/** Every record formatted as a log-file line, joined: handy for "never contains X" checks. */
	text(): string {
		return this.records.map(formatLogRecord).join("\n");
	}

	clear(): void {
		this.records.length = 0;
	}
}
