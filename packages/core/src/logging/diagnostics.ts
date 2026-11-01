// GLIM-35: the "Copy diagnostics" bundle for bug reports. The app collects the facts
// (app/src/bun/services/diagnostics.ts); this turns them into one plain-text block the
// user pastes into an issue. Everything passes through the Redactor again, so the bundle
// is safe to post publicly: no keys, no screen text, no pixels, home dir shown as `~`.

import type { Display } from "../region.ts";
import { formatLogValue } from "./format.ts";
import type { Redactor } from "./redact.ts";
import type { JsonLogValue } from "./types.ts";

export interface DiagnosticsProvider {
	readonly id: string;
	readonly name: string;
	readonly task: string;
	readonly kind: string;
	/** Where it sits in the user's selection: `ocr`, `translation #1`, or null (installed, not selected). */
	readonly selected: string | null;
	/** Lifecycle status if the provider is running (`ready`, `model-missing`, ...), else null. */
	readonly status: string | null;
}

export interface DiagnosticsInfo {
	/** Epoch ms when the bundle was made. */
	readonly generatedAt: number;
	readonly app: { readonly name: string; readonly version: string; readonly channel?: string };
	readonly runtime: Readonly<Record<string, string>>;
	readonly os: Readonly<Record<string, string>>;
	readonly displays: readonly Display[];
	readonly providers: readonly DiagnosticsProvider[];
	/** Short facts: settings source and warnings count, log level, keychain availability, native helper state... */
	readonly state: Readonly<Record<string, unknown>>;
	/** Newest last; already-formatted, already-redacted log lines. */
	readonly logTail: readonly string[];
}

const section = (title: string, lines: readonly string[]) =>
	[`## ${title}`, ...(lines.length ? lines : ["(none)"]), ""].join("\n");

const kv = (redactor: Redactor, record: Readonly<Record<string, unknown>>): string[] =>
	Object.entries(record)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${k}: ${formatValue(redactor.field(k, v, 0, new Set()))}`);

const formatValue = (v: JsonLogValue): string => (typeof v === "string" ? v : formatLogValue(v));

export function formatDiagnostics(info: DiagnosticsInfo, redactor: Redactor): string {
	const app = `${info.app.name} ${info.app.version}${info.app.channel ? ` (${info.app.channel})` : ""}`;
	const displays = info.displays.map((d) => {
		const b = d.bounds;
		const w = d.workArea;
		return `#${d.id}${d.isPrimary ? " primary" : ""}: ${b.width}x${b.height} at ${b.x},${b.y} scale ${d.scaleFactor}, work area ${w.width}x${w.height} at ${w.x},${w.y}`;
	});
	const providers = info.providers.map(
		(p) =>
			`${p.id} (${p.name}, ${p.task}, ${p.kind}): ${p.selected ?? "not selected"}${p.status ? `, ${p.status}` : ""}`,
	);
	const text = [
		`# Glimpse diagnostics`,
		``,
		`Generated ${new Date(info.generatedAt).toISOString()}. Contains no API keys, screen text or screenshots.`,
		``,
		section("App", [app, ...kv(redactor, info.runtime)]),
		section("System", kv(redactor, info.os)),
		section(`Displays (${info.displays.length})`, displays),
		section("Providers", providers),
		section("State", kv(redactor, info.state)),
		section(
			`Recent log (${info.logTail.length} lines)`,
			info.logTail.map((l) => redactor.string(l)),
		),
	].join("\n");
	return `${text.trimEnd()}\n`;
}
