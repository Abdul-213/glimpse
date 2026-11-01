// Browser preview of the Snip popup (dev tool, not shipped): the real SnipPopup view fed
// with scenario states (scenarios.ts) instead of RPC. Each frame plays the window: its
// height follows the view's `resized` report, capped at the layout's maxHeight, the way
// main sizes the real window. Build + serve: `bun app/scripts/popup-shots.ts --serve`.
//
//   ?scenario=s4-done (default: all)   ?os=macos|windows|win10   ?dir=rtl
import { applyPlatform } from "@glimpse/ui";
import { createSignal, For } from "solid-js";
import { render } from "solid-js/web";
import { snipViewInit } from "../../src/bun/windows/popup-init.ts";
import { SnipPopup } from "../../src/views/popup/SnipPopup.tsx";
import { ALL_SCENARIOS as SCENARIOS, scenarioMessage } from "./scenarios.ts";

const q = new URLSearchParams(location.search);
const osParam = q.get("os") ?? "macos";
const os = osParam === "windows" || osParam === "win10" ? "windows" : "macos";
applyPlatform(os, { material: "none", ...(osParam === "win10" ? { osVersion: "10" } : {}) });
const dir = q.get("dir") === "rtl" ? "rtl" : "ltr";
document.documentElement.dir = dir;
const only = q.get("scenario");
const list = SCENARIOS.filter((s) => !only || s.name === only);
const init = { ...snipViewInit(os), uiDir: dir as "ltr" | "rtl" };
let painted = 0;

function Frame(props: { scenario: (typeof SCENARIOS)[number] }) {
	const message = scenarioMessage(props.scenario);
	const [height, setHeight] = createSignal<number | null>(null);
	return (
		<div
			class="preview-frame"
			data-scenario={props.scenario.name}
			style={{
				width: `${message.layout.width}px`,
				height: height() === null ? "auto" : `${Math.min(height() ?? 0, message.layout.maxHeight)}px`,
			}}
		>
			<SnipPopup
				init={init}
				message={message}
				intents={{
					painted: () => {
						painted++;
						document.body.dataset["painted"] = String(painted);
					},
					resized: (_id, h) => setHeight(h),
					dismiss: () => {},
					skipped: () => {},
					action: () => {},
					retryBlock: () => {},
				}}
			/>
		</div>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("preview: #root missing");
render(
	() => (
		<div class="preview-stage">
			<For each={list}>{(s) => <Frame scenario={s} />}</For>
		</div>
	),
	root,
);
