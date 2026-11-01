// GLIM-35: collects the facts for "Copy diagnostics" and formats them with core's
// `formatDiagnostics` (which redacts again). Inputs are passed in, so this has no
// Electrobun imports and is tested on Linux; the composition root supplies displays,
// the registry and settings, and puts the text on the clipboard.

import { arch, type as osType, version as osVersion, release } from "node:os";
import {
	type DiagnosticsProvider,
	type Display,
	formatDiagnostics,
	type ProviderRegistry,
	type ProvidersConfig,
	type Redactor,
} from "@glimpse/core";
import type { AppInfo } from "../../shared/rpc.ts";

export interface DiagnosticsSources {
	readonly appInfo: AppInfo;
	readonly displays: () => readonly Display[];
	readonly providers: ProviderRegistry<unknown>;
	readonly providersConfig: () => ProvidersConfig;
	/** Running provider status by id, when a pipeline exists (later tickets). */
	readonly providerStatus?: (id: string) => string | null;
	/** Short state facts (settings source, log level, keychain availability...). */
	readonly state: () => Readonly<Record<string, unknown>>;
	readonly logTail: () => readonly string[];
	readonly redactor: Redactor;
	readonly now?: () => number;
	readonly locale?: string;
}

export function providerRows(
	registry: ProviderRegistry<unknown>,
	config: ProvidersConfig,
	status: (id: string) => string | null = () => null,
): DiagnosticsProvider[] {
	return registry.list().map((f) => {
		const { id, name, task, kind } = f.info;
		const chainIndex = config.translation.indexOf(id);
		const selected =
			task === "ocr" ? (config.ocr === id ? "ocr" : null) : chainIndex >= 0 ? `translation #${chainIndex + 1}` : null;
		return { id, name, task, kind, selected, status: status(id) };
	});
}

const safe = <T>(read: () => T, fallback: T): T => {
	try {
		return read();
	} catch {
		return fallback;
	}
};

export function buildDiagnostics(sources: DiagnosticsSources): string {
	const { appInfo } = sources;
	const config = safe(sources.providersConfig, { ocr: null, translation: [], options: {} });
	return formatDiagnostics(
		{
			generatedAt: (sources.now ?? Date.now)(),
			app: { name: appInfo.name, version: appInfo.version },
			runtime: { electrobun: appInfo.electrobun, bun: appInfo.bun },
			os: {
				platform: appInfo.platform,
				type: safe(osType, "unknown"),
				release: safe(release, "unknown"),
				version: safe(osVersion, "unknown"),
				arch: safe(arch, "unknown"),
				locale: sources.locale ?? "unknown",
			},
			displays: safe(sources.displays, []),
			providers: providerRows(sources.providers, config, sources.providerStatus),
			state: safe(sources.state, {}),
			logTail: safe(sources.logTail, []),
		},
		sources.redactor,
	);
}
