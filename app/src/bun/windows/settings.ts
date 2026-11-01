import { BrowserView, BrowserWindow } from "electrobun/main";
import type { AppInfo, SettingsRPC } from "../../shared/rpc.ts";

/**
 * The Settings window: one instance, created on demand, re-activated if already open.
 * DESIGN.md Layout > Settings: 720 x 520 minimum. Native materials (Mica /
 * windowBackground vibrancy) arrive with the settings window work (GLIM-69); until
 * then the view paints a solid surface.
 */
export class SettingsWindow {
	private window: BrowserWindow | null = null;

	constructor(private readonly appInfo: AppInfo) {}

	open(): void {
		if (this.window) {
			this.window.activate();
			return;
		}
		const rpc = BrowserView.defineRPC<SettingsRPC>({
			maxRequestTime: 5_000,
			handlers: {
				requests: {
					getAppInfo: () => this.appInfo,
				},
				messages: {
					closeSettings: () => this.window?.close(),
				},
			},
		});
		const win = new BrowserWindow({
			title: "Glimpse Settings",
			url: "views://settings/index.html",
			frame: { width: 720, height: 520 },
			rpc,
		});
		win.on("close", () => {
			this.window = null;
		});
		this.window = win;
	}
}
