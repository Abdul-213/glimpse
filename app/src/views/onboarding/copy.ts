// Words and actions for the screen-access step (GLIM-45), as a pure function of the status
// main reports, so every state is tested on Linux and rendered by the preview.
import type { ScreenAccessStatus } from "../../shared/onboarding-rpc.ts";

export type ScreenAccessAction = "request" | "open-settings" | "restart" | "done";

export interface ScreenAccessCopy {
	/** The status at the end of the "Screen Recording" row. */
	readonly status: string;
	readonly tone: "success" | "neutral" | "warning";
	readonly banner: {
		readonly tone: "info" | "warning" | "success";
		readonly title: string;
		readonly body: string;
	} | null;
	readonly primary: { readonly label: string; readonly action: ScreenAccessAction };
	readonly secondary: { readonly label: string; readonly action: ScreenAccessAction } | null;
	/** Show the "unsigned build" note with the install-guide link. */
	readonly unsignedNote: boolean;
}

/** Where the switch lives. macOS 15 renamed the pane "Screen & System Audio Recording". */
export const PANE_PATH = "Privacy & Security › Screen & System Audio Recording";

export function screenAccessCopy(s: ScreenAccessStatus): ScreenAccessCopy {
	const restart = s.canRestart
		? ({ label: "Restart Glimpse", action: "restart" } as const)
		: ({ label: "Open System Settings", action: "open-settings" } as const);
	const restartWords = s.canRestart ? "restart Glimpse" : "quit Glimpse from the menu bar and open it again";
	switch (s.state) {
		case "not-needed":
		case "granted":
			return {
				status: "Allowed",
				tone: "success",
				banner: null,
				primary: { label: "Continue", action: "done" },
				secondary: null,
				unsignedNote: false,
			};
		case "not-determined":
			return {
				status: "Not allowed yet",
				tone: "neutral",
				banner: null,
				primary: { label: "Allow screen access", action: "request" },
				secondary: null,
				unsignedNote: true,
			};
		case "denied":
			return s.settingsOpened
				? {
						status: "Waiting for a restart",
						tone: "neutral",
						banner: {
							tone: "info",
							title: "Turned Glimpse on? Restart it to finish.",
							body: `macOS only applies the change when Glimpse starts again. If the switch is still off, turn on Glimpse in ${PANE_PATH}.`,
						},
						primary: restart,
						secondary: s.canRestart ? { label: "Open System Settings", action: "open-settings" } : null,
						unsignedNote: true,
					}
				: {
						status: "Not allowed",
						tone: "warning",
						banner: {
							tone: "info",
							title: "Turn on Glimpse in System Settings",
							body: `Open ${PANE_PATH}, switch Glimpse on, then ${restartWords}.`,
						},
						primary: { label: "Open System Settings", action: "open-settings" },
						secondary: null,
						unsignedNote: true,
					};
		case "lost":
			return {
				status: "Not allowed",
				tone: "warning",
				banner: {
					tone: "warning",
					title: "Glimpse lost its screen access",
					body:
						"This usually happens after an update: this build isn't signed by Apple, so macOS treats each new version as a different app. " +
						`In ${PANE_PATH}, Glimpse may still look switched on: switch it off and on again, or remove it with the minus button and add it back. Then ${restartWords}.`,
				},
				primary: s.settingsOpened ? restart : { label: "Open System Settings", action: "open-settings" },
				secondary: s.settingsOpened && s.canRestart ? { label: "Open System Settings", action: "open-settings" } : null,
				unsignedNote: false,
			};
	}
}
