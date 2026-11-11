// What the Settings view needs from the main process. index.tsx implements it over RPC; the
// dev-only preview (views/settings-preview) implements it with fake data for screenshots.
import type {
	CloudSnapshot,
	HotkeyStatus,
	ModelsSnapshot,
	SettingsRPC,
	SettingsSection,
} from "../../shared/settings-rpc.ts";

type Requests = SettingsRPC["bun"]["requests"];

/** `request.<name>(params)` for every bun request in the Settings schema. */
export type SettingsRequests = {
	[K in keyof Requests]: Requests[K]["params"] extends undefined
		? () => Promise<Requests[K]["response"]>
		: (params: Requests[K]["params"]) => Promise<Requests[K]["response"]>;
};

export interface SettingsPushHandlers {
	settingsChanged: (s: import("@glimpse/core").Settings) => void;
	hotkeysChanged: (s: HotkeyStatus) => void;
	modelsChanged: (s: ModelsSnapshot) => void;
	cloudChanged: (s: CloudSnapshot) => void;
	updateChanged: (s: import("@glimpse/core").UpdateStatus) => void;
	/** Main asks for a pane (Settings opened at a section while already open). */
	showSection: (s: SettingsSection) => void;
}

export interface SettingsClient {
	readonly request: SettingsRequests;
	/** Register the view's push handlers (called once at startup). */
	listen(handlers: SettingsPushHandlers): void;
	close(): void;
}
