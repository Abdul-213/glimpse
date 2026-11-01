// GLIM-41: the tray / menu-bar item. Renders `TrayController` state (tray-menu.ts, pure)
// with Electrobun's Tray, and turns clicks into command-bus dispatches. Rebuilding happens
// only when the menu or icon actually changes.
import { Tray } from "electrobun/main";
import type { Platform } from "../shared/rpc.ts";
import { type CommandBus, isCommand } from "./commands.ts";
import { TrayController, type TrayMenuItem, type TrayState, trayIconFor } from "./tray-menu.ts";

type ElectrobunMenu = Parameters<Tray["setMenu"]>[0];

// Electrobun's MenuItemConfig is mutable and loosely typed; our items are a strict subset.
const toElectrobun = (menu: readonly TrayMenuItem[]): ElectrobunMenu =>
	menu.map((item) =>
		item.type === "divider"
			? { type: "divider" }
			: {
					type: "normal",
					label: item.label,
					...(item.action ? { action: item.action } : {}),
					...(item.enabled === false ? { enabled: false } : {}),
					...(item.checked ? { checked: true } : {}),
					...(item.tooltip ? { tooltip: item.tooltip } : {}),
					...(item.submenu ? { submenu: toElectrobun(item.submenu) } : {}),
				},
	);

export function createTray(initial: TrayState, commands: CommandBus): TrayController {
	const platform: Platform = initial.platform;
	const tray = new Tray({ ...trayIconFor(platform, initial.taskbarTheme), width: 16, height: 16 });
	const controller = new TrayController(
		{
			setMenu: (menu) => tray.setMenu(toElectrobun(menu)),
			setImage: (image) => tray.setImage(image),
		},
		initial,
	);
	tray.on("tray-clicked", (event: unknown) => {
		const action = (event as { data?: { action?: unknown } }).data?.action;
		if (isCommand(action)) void commands.dispatch(action, "tray");
	});
	return controller;
}
