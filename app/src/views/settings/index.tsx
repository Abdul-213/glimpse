import { applyPlatform } from "@glimpse/ui";
import { render } from "solid-js/web";
import type { SettingsRPC } from "../../shared/rpc.ts";
import { connect } from "../rpc.ts";
import { SettingsApp } from "./SettingsApp.tsx";

const rpc = connect<SettingsRPC>({ requests: {}, messages: {} });

const root = document.getElementById("root");
if (!root) throw new Error("settings: #root missing from index.html");

render(
	() => (
		<SettingsApp
			loadInfo={async () => {
				const info = await rpc.request.getAppInfo();
				applyPlatform(info.platform);
				return info;
			}}
			onClose={() => rpc.send.closeSettings()}
		/>
	),
	root,
);
