// Launch at login (GLIM-77). Off by default; the setting (`system.launchAtLogin`) is the
// user's choice and this service makes the OS match it.
//
// macOS: a per-user LaunchAgent, `~/Library/LaunchAgents/dev.glimpse.app.login.plist`, that
//   runs `/usr/bin/open <Glimpse.app>` at login. Chosen over `SMAppService.mainApp` because
//   Glimpse ships unsigned / ad-hoc signed: SMAppService ties the login item to the code
//   signature, so it fails outright for an unsigned bundle and, with an ad-hoc signature that
//   changes on every build, the approval is lost after each update. A LaunchAgent plist works
//   for any bundle, needs no native code, and `open` launches through LaunchServices (so the
//   app gets its normal environment and isn't a child of launchd). macOS 13+ lists it under
//   System Settings > General > Login Items > "Allow in the Background" and shows a one-time
//   "Background item added" notification; the user can switch it off there. Full reasoning:
//   docs/decisions/GLIM-77-launch-at-login.md.
// Windows: a `Glimpse` value under HKCU\Software\Microsoft\Windows\CurrentVersion\Run with the
//   quoted path of Electrobun's launcher.exe (it sits next to bun.exe). Written with reg.exe,
//   so no native code. Task Manager's Startup tab can disable it (StartupApproved); we report
//   only whether our value exists.
// Linux (dev/CI) and unpackaged dev runs: unsupported, the switch is disabled with a reason.
//
// Pure planning (paths, file contents, commands) is separated from I/O so it is tested on Linux.
import { dirname, join, resolve } from "node:path";
import type { LoginItemStatus } from "../../shared/settings-rpc.ts";

export const LAUNCH_AGENT_LABEL = "dev.glimpse.app.login";
export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const RUN_VALUE = "Glimpse";

export type LoginTarget =
	| { readonly os: "macos"; readonly bundle: string; readonly plist: string }
	| { readonly os: "windows"; readonly launcher: string }
	| { readonly os: "unsupported"; readonly reason: string };

/** The `.app` bundle that contains `execPath` (`…/Glimpse.app/Contents/MacOS/bun`), or null. */
export function macBundleOf(execPath: string): string | null {
	const parts = execPath.split("/");
	const i = parts.findLastIndex((p) => p.endsWith(".app"));
	if (i <= 0) return null;
	return parts.slice(0, i + 1).join("/");
}

export interface TargetInputs {
	readonly platform: "macos" | "windows" | "linux";
	readonly execPath: string;
	readonly home: string;
	readonly exists: (path: string) => boolean;
}

/** Work out what to register for this run, or why we can't. */
export function loginTarget(input: TargetInputs): LoginTarget {
	if (input.platform === "macos") {
		const bundle = macBundleOf(input.execPath);
		if (!bundle) return { os: "unsupported", reason: "Only available when Glimpse runs from its app bundle." };
		return { os: "macos", bundle, plist: join(input.home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`) };
	}
	if (input.platform === "windows") {
		const launcher = join(dirname(input.execPath), "launcher.exe");
		if (!input.exists(launcher))
			return { os: "unsupported", reason: "Only available in an installed copy of Glimpse." };
		return { os: "windows", launcher };
	}
	return { os: "unsupported", reason: "Not available on this system." };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The LaunchAgent plist for a bundle. `-g` would keep Glimpse in the background; it has no window to raise anyway. */
export function launchAgentPlist(bundle: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCH_AGENT_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/open</string>
		<string>${xml(resolve(bundle))}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>ProcessType</key>
	<string>Interactive</string>
</dict>
</plist>
`;
}

/** The Run value data: the launcher's path, quoted (paths with spaces). */
export const runValueData = (launcher: string): string => `"${launcher}"`;

export const regAddArgs = (launcher: string): string[] => [
	"add",
	RUN_KEY,
	"/v",
	RUN_VALUE,
	"/t",
	"REG_SZ",
	"/d",
	runValueData(launcher),
	"/f",
];
export const regDeleteArgs = (): string[] => ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"];
export const regQueryArgs = (): string[] => ["query", RUN_KEY, "/v", RUN_VALUE];

/** Parse `reg query` output: the REG_SZ data of our value, or null. */
export function parseRegQuery(stdout: string): string | null {
	for (const line of stdout.split(/\r?\n/)) {
		const m = /^\s*Glimpse\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
		if (m?.[1] !== undefined) return m[1].trim();
	}
	return null;
}

/** The OS calls the service needs; the real ones are in `systemLoginItemIO`. */
export interface LoginItemIO {
	readFile(path: string): Promise<string | null>;
	writeFile(path: string, contents: string): Promise<void>;
	removeFile(path: string): Promise<void>;
	/** Run reg.exe; resolves with exit code and stdout. */
	reg(args: string[]): Promise<{ code: number; stdout: string }>;
}

export class LoginItem {
	constructor(
		private readonly target: LoginTarget,
		private readonly io: LoginItemIO,
	) {}

	/** Is our entry present and pointing at this copy of Glimpse? */
	async status(): Promise<LoginItemStatus> {
		const t = this.target;
		if (t.os === "unsupported") return { enabled: false, supported: false, reason: t.reason };
		if (t.os === "macos") {
			const text = await this.io.readFile(t.plist);
			return { enabled: text === launchAgentPlist(t.bundle), supported: true };
		}
		const { code, stdout } = await this.io.reg(regQueryArgs());
		return { enabled: code === 0 && parseRegQuery(stdout) === runValueData(t.launcher), supported: true };
	}

	/** Make the OS match `enabled`. Throws with a user-readable message when the OS refuses. */
	async set(enabled: boolean): Promise<LoginItemStatus> {
		const t = this.target;
		if (t.os === "unsupported") return { enabled: false, supported: false, reason: t.reason };
		if (t.os === "macos") {
			if (enabled) await this.io.writeFile(t.plist, launchAgentPlist(t.bundle));
			else await this.io.removeFile(t.plist);
		} else {
			const { code } = await this.io.reg(enabled ? regAddArgs(t.launcher) : regDeleteArgs());
			// Deleting a value that isn't there exits 1; that's the state we wanted.
			if (code !== 0 && enabled) throw new Error(`Windows refused the startup entry (reg.exe exit ${code}).`);
		}
		return this.status();
	}

	/**
	 * At startup: make the OS match the setting. An enabled entry is re-pointed at this copy
	 * (the app moved or updated); a leftover entry for this copy is removed when the setting is off.
	 */
	async reconcile(wanted: boolean): Promise<LoginItemStatus> {
		const now = await this.status();
		if (!now.supported) return now;
		if (wanted !== now.enabled) return this.set(wanted);
		return now;
	}
}

/** Real I/O. Imports only node:/bun APIs, so it is safe (if unused) on Linux. */
export function systemLoginItemIO(): LoginItemIO {
	return {
		async readFile(path) {
			const file = Bun.file(path);
			return (await file.exists()) ? file.text() : null;
		},
		async writeFile(path, contents) {
			const { mkdir, writeFile } = await import("node:fs/promises");
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, contents, { mode: 0o644 });
		},
		async removeFile(path) {
			const { rm } = await import("node:fs/promises");
			await rm(path, { force: true });
		},
		async reg(args) {
			const proc = Bun.spawn(["reg.exe", ...args], { stdout: "pipe", stderr: "ignore", windowsHide: true });
			const stdout = await new Response(proc.stdout).text();
			return { code: await proc.exited, stdout };
		},
	};
}
