// GLIM-164: "Show Glimpse in screen sharing and recordings" (`privacy.showInScreenSharing`,
// on by default; provisional owner decision). One setting, two switches: Settings › Privacy
// and the tray's "Show in screen sharing" checkbox (the owner asked for a quick toggle, e.g.
// before going live on Discord). Every change, from either one, reaches the open windows at
// once through `CaptureExclusion.setHideFromCapture` and ticks the tray item.
//
// No electrobun imports: the composition root passes AppSettings, the tray and the command
// bus, and tests pass fakes.
import type { Settings, SettingsPatch } from "@glimpse/core";
import type { CommandBus } from "./commands.ts";
import type { TrayState } from "./tray-menu.ts";

export interface ScreenSharingDeps {
	readonly settings: {
		readonly current: Settings;
		update(patch: SettingsPatch): Promise<unknown>;
		subscribe(listener: (next: Settings, previous: Settings) => void): () => void;
	};
	readonly exclusion: { setHideFromCapture(hidden: boolean): void };
	readonly tray: { update(patch: Partial<TrayState>): void } | null;
	readonly commands: Pick<CommandBus, "handle">;
}

/**
 * Apply the saved value, handle the tray command and follow every later change. Returns an
 * unsubscribe function (tests).
 */
export function wireScreenSharing(deps: ScreenSharingDeps): () => void {
	const shown = () => deps.settings.current.privacy.showInScreenSharing;
	deps.exclusion.setHideFromCapture(!shown());
	deps.tray?.update({ showInScreenSharing: shown() });
	const unhandle = deps.commands.handle("screen-sharing.toggle", () => {
		void deps.settings.update({ privacy: { showInScreenSharing: !shown() } });
	});
	const unsubscribe = deps.settings.subscribe((next, previous) => {
		const on = next.privacy.showInScreenSharing;
		if (on === previous.privacy.showInScreenSharing) return;
		deps.exclusion.setHideFromCapture(!on);
		deps.tray?.update({ showInScreenSharing: on });
	});
	return () => {
		unhandle();
		unsubscribe();
	};
}
