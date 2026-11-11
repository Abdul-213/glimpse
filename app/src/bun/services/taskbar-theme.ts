// GLIM-41: the Windows taskbar theme, so the tray uses the light glyph on a dark taskbar and
// the dark glyph on a light one. Windows stores it as
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize  SystemUsesLightTheme (DWORD)
// (1 = light taskbar and Start; missing on Windows 10 before 1903, whose taskbar is always
// dark). Electrobun has no theme event and the native helper (glimpse.dll) doesn't exist
// yet, so we read it with `reg.exe` and poll. A change from Settings > Personalization
// shows up within one poll interval.
//
// No electrobun imports; the parsing is tested on Linux.

import type { TaskbarTheme } from "../tray-menu.ts";

export const PERSONALIZE_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
export const LIGHT_THEME_VALUE = "SystemUsesLightTheme";

/** Parse `reg query <key> /v SystemUsesLightTheme` output. Null when the value isn't there. */
export function parseTaskbarTheme(regOutput: string): TaskbarTheme | null {
	const m = new RegExp(`${LIGHT_THEME_VALUE}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, "i").exec(regOutput);
	if (!m?.[1]) return null;
	return Number.parseInt(m[1], 16) === 1 ? "light" : "dark";
}

export type RunCommand = (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string }>;

const runWithBun: RunCommand = async (argv) => {
	const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore", windowsHide: true });
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return { exitCode, stdout };
};

export async function readTaskbarTheme(run: RunCommand = runWithBun): Promise<TaskbarTheme> {
	try {
		const { exitCode, stdout } = await run(["reg", "query", PERSONALIZE_KEY, "/v", LIGHT_THEME_VALUE]);
		return (exitCode === 0 ? parseTaskbarTheme(stdout) : null) ?? "dark";
	} catch {
		return "dark";
	}
}

export interface TaskbarThemeWatcher {
	/** Settles once the first read has been reported. */
	readonly ready: Promise<void>;
	stop(): void;
}

/** Repeating timer. `fn` returns the poll's promise so a fake clock can await each tick. */
export type Every = (ms: number, fn: () => Promise<void>) => () => void;

const realEvery: Every = (ms, fn) => {
	const timer = setInterval(() => void fn(), ms);
	return () => clearInterval(timer);
};

/** Calls `onChange` with the current theme now and whenever it changes. Windows only. */
export function watchTaskbarTheme(
	onChange: (theme: TaskbarTheme) => void,
	options: { readonly intervalMs?: number; readonly run?: RunCommand; readonly every?: Every } = {},
): TaskbarThemeWatcher {
	let last: TaskbarTheme | null = null;
	let busy = false;
	let stopped = false;
	const check = async () => {
		if (busy || stopped) return;
		busy = true;
		try {
			const theme = await readTaskbarTheme(options.run);
			if (theme !== last && !stopped) {
				last = theme;
				onChange(theme);
			}
		} finally {
			busy = false;
		}
	};
	const ready = check();
	const cancel = (options.every ?? realEvery)(options.intervalMs ?? 10_000, check);
	return {
		ready,
		stop: () => {
			stopped = true;
			cancel();
		},
	};
}
