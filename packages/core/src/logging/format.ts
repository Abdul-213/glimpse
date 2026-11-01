// GLIM-35: one log record -> one line. Readable in a text editor and greppable, while
// keeping fields structured (logfmt-style `key=value`, values JSON-encoded when needed):
//
//   2026-11-01T12:00:00.000Z INFO  settings: loaded source=file warnings=0 path="~/Library/..."
//
// Records are already redacted; formatting only escapes.

import type { JsonLogValue, LogLevel, LogRecord } from "./types.ts";

const LABEL: Readonly<Record<LogLevel, string>> = { error: "ERROR", warn: "WARN ", info: "INFO ", debug: "DEBUG" };

const BARE = /^[A-Za-z0-9_.:/@+~-]+$/;

export function formatLogValue(value: JsonLogValue): string {
	if (typeof value === "string") return value !== "" && BARE.test(value) ? value : JSON.stringify(value);
	return JSON.stringify(value);
}

const fieldKey = (key: string): string => (BARE.test(key) && !key.includes("=") ? key : JSON.stringify(key));

export function formatLogRecord(record: LogRecord): string {
	const time = new Date(record.time).toISOString();
	const scope = record.scope ? `${record.scope}: ` : "";
	// One record, one line: escape line breaks in the message.
	const message = record.message.replace(/\r?\n/g, "\\n");
	let line = `${time} ${LABEL[record.level]} ${scope}${message}`;
	for (const [key, value] of Object.entries(record.fields)) line += ` ${fieldKey(key)}=${formatLogValue(value)}`;
	return line;
}
