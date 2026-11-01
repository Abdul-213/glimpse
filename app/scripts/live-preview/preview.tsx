// Browser preview of the docked Live popup (dev tool, not shipped): the real LivePopup view
// fed with scenario states (scenarios.ts) instead of RPC. Each frame plays the window: its
// height follows the view's `resized` report, capped at the layout's maxHeight.
// Build + serve: `bun app/scripts/live-shots.ts --serve`.
//
//   ?scenario=l4-changed (default: all)   ?os=macos|windows|win10   ?dir=rtl
import { applyPlatform } from "@glimpse/ui";
import { createSignal, For } from "solid-js";
import { render } from "solid-js/web";
import { liveViewInit } from "../../src/bun/windows/live-popup-controller.ts";
import { LivePopup } from "../../src/views/live/LivePopup.tsx";
import { LIVE_SCENARIOS, liveScenarioMessage } from "./scenarios.ts";

const q = new URLSearchParams(location.search);
const osParam = q.get("os") ?? "macos";
const os = osParam === "windows" || osParam === "win10" ? "windows" : "macos";
applyPlatform(os, { material: "none", ...(osParam === "win10" ? { osVersion: "10" } : {}) });
const dir = q.get("dir") === "rtl" ? "rtl" : "ltr";
document.documentElement.dir = dir;
document.documentElement.dataset["motion"] = q.get("motion") === "full" ? "full" : "reduced";
const only = q.get("scenario");
const list = LIVE_SCENARIOS.filter((s) => !only || s.name === only);
const init = { ...liveViewInit(os), uiDir: dir as "ltr" | "rtl" };
let painted = 0;
const noop = () => {};

function Frame(props: { scenario: (typeof LIVE_SCENARIOS)[number] }) {
	const message = { ...liveScenarioMessage(props.scenario), reducedMotion: q.get("motion") !== "full" };
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
			<LivePopup
				init={init}
				message={message}
				shrinkDelayMs={0}
				intents={{
					painted: () => {
						painted++;
						document.body.dataset["painted"] = String(painted);
					},
					resized: (_id, h) => setHeight(h),
					pause: noop,
					resume: noop,
					stop: noop,
					repin: noop,
					setPrivate: noop,
					consent: noop,
					hoverBlock: noop,
					pointerEntered: noop,
					blurred: noop,
					copy: noop,
					skipped: noop,
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
