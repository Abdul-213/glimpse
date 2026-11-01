import { applyPlatform } from "@glimpse/ui";
import { render } from "solid-js/web";
import type { SettingsRPC } from "../../shared/settings-rpc.ts";
import { connect } from "../rpc.ts";
import type { SettingsClient, SettingsPushHandlers } from "./client.ts";
import { SettingsApp } from "./SettingsApp.tsx";

// Push handlers are registered by the app after it mounts; until then pushes are dropped
// (the snapshot request that follows carries the same state).
let handlers: SettingsPushHandlers | null = null;

const rpc = connect<SettingsRPC>(
	{
		requests: {},
		messages: {
			settingsChanged: (s) => handlers?.settingsChanged(s),
			hotkeysChanged: (s) => handlers?.hotkeysChanged(s),
			modelsChanged: (s) => handlers?.modelsChanged(s),
			cloudChanged: (s) => handlers?.cloudChanged(s),
		},
	},
	// Moving the models folder between disks can take minutes.
	10 * 60_000,
);

const client: SettingsClient = {
	request: rpc.request,
	listen: (h) => {
		handlers = h;
	},
	close: () => rpc.send.closeSettings(),
};

const root = document.getElementById("root");
if (!root) throw new Error("settings: #root missing from index.html");

render(() => <SettingsApp client={client} onReady={(platform) => applyPlatform(platform)} />, root);
