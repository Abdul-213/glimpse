import { Tray } from "electrobun/main";
import type { Platform } from "../shared/rpc.ts";

export type TrayAction = "settings" | "copy-diagnostics" | "open-logs" | "quit";

const TRAY_ACTIONS: readonly string[] = ["settings", "copy-diagnostics", "open-logs", "quit"];
const isTrayAction = (value: unknown): value is TrayAction => typeof value === "string" && TRAY_ACTIONS.includes(value);

/**
 * Tray icon per platform (DESIGN.md Shapes: monochrome; template image on macOS,
 * light/dark variants on Windows). The PNGs are copied to views://assets/ by
 * electrobun.config.ts. Following the Windows taskbar theme is GLIM-41's job.
 */
export function trayIconFor(platform: Platform): { image: string; template: boolean } {
	switch (platform) {
		case "macos":
			return { image: "views://assets/tray-template.png", template: true };
		case "windows":
			return { image: "views://assets/tray-light.png", template: false };
		default:
			return { image: "views://assets/tray-dark.png", template: false };
	}
}

export function createTray(platform: Platform, onAction: (action: TrayAction) => void): Tray {
	const tray = new Tray({ ...trayIconFor(platform), width: 16, height: 16 });
	tray.setMenu([
		{ type: "normal", label: "Settings…", action: "settings" },
		{
			type: "normal",
			label: "Troubleshooting",
			submenu: [
				{
					type: "normal",
					label: platform === "macos" ? "Copy Diagnostics" : "Copy diagnostics",
					action: "copy-diagnostics",
				},
				{ type: "normal", label: platform === "macos" ? "Open Logs Folder" : "Open logs folder", action: "open-logs" },
			],
		},
		{ type: "divider" },
		{ type: "normal", label: "Quit Glimpse", action: "quit" },
	]);
	tray.on("tray-clicked", (event: unknown) => {
		const action = (event as { data?: { action?: unknown } }).data?.action;
		if (isTrayAction(action)) onAction(action);
	});
	return tray;
}
