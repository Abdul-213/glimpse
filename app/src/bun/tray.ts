// GLIM-41: the tray / menu-bar item. Renders `TrayController` state (tray-menu.ts, pure)
// with Electrobun's Tray, and turns clicks into command-bus dispatches. Rebuilding happens
// only when the menu or icon actually changes.
import { Tray } from "electrobun/main";
import type { Platform } from "../shared/rpc.ts";
import { type CommandBus, isCommand } from "./commands.ts";
import { TRAY_POINTS, trayImageSetter } from "./native/tray-image.ts";
import { trayAccessibleNameSetter } from "./native/tray-label.ts";
import { TrayController, type TrayMenuItem, type TrayState, trayIconForState } from "./tray-menu.ts";

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
	// The badge follows the state (GLIM-99); trayAccessibleNameSetter below keeps GLIM-136's name.
	const tray = new Tray({ ...trayIconForState(initial), width: TRAY_POINTS, height: TRAY_POINTS });
	const controller = new TrayController(
		{
			setMenu: (menu) => tray.setMenu(toElectrobun(menu)),
			// macOS keeps the badge a 16 pt template image (Electrobun's setImage drops both).
			setImage: trayImageSetter(platform, tray),
			setAccessibleName: trayAccessibleNameSetter(platform, tray),
		},
		initial,
	);
	tray.on("tray-clicked", (event: unknown) => {
		const action = (event as { data?: { action?: unknown } }).data?.action;
		if (isCommand(action)) void commands.dispatch(action, "tray");
	});
	return controller;
}
