// Docked Live popup view entry (GLIM-79). Loaded hidden at launch into the pre-created Live
// window; main pushes `liveState`, the view renders it in place and sends intents back.
import { applyPlatform } from "@glimpse/ui";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import type { LiveRPC, LiveStateMessage, LiveViewInit } from "../../shared/live-rpc.ts";
import { connect } from "../rpc.ts";
import { LivePopup } from "./LivePopup.tsx";

const [init, setInit] = createSignal<LiveViewInit | null>(null);
const [message, setMessage] = createSignal<LiveStateMessage | null>(null);

const rpc = connect<LiveRPC>({
	requests: {},
	messages: {
		liveState: (m) => {
			document.documentElement.dataset["motion"] = m.reducedMotion ? "reduced" : "full";
			setMessage(m);
		},
		liveFocus: () => {
			// "Focus Live popup": the controller already activated the window; LivePopup moves
			// focus once `focused` arrives in the next state.
		},
		liveAnnounce: () => {},
	},
});

document.addEventListener("contextmenu", (e) => e.preventDefault());

rpc.request
	.getLiveInit()
	.then((i) => {
		applyPlatform(i.os, { material: "none" });
		document.documentElement.lang = i.uiLang;
		document.documentElement.dir = i.uiDir;
		setInit(i);
	})
	.catch(() => {});

const root = document.getElementById("root");
if (!root) throw new Error("live: #root missing from index.html");

render(
	() => (
		<Show when={init()}>
			{(i) => (
				<Show when={message()}>
					{(m) => (
						<LivePopup
							init={i()}
							message={m()}
							intents={{
								painted: (sessionId) => rpc.send.livePainted({ sessionId }),
								resized: (sessionId, contentHeight) => rpc.send.liveResized({ sessionId, contentHeight }),
								pause: (sessionId) => rpc.send.pauseRequested({ sessionId }),
								resume: (sessionId) => rpc.send.resumeRequested({ sessionId }),
								stop: (sessionId) => rpc.send.stopRequested({ sessionId }),
								repin: (sessionId) => rpc.send.repinRequested({ sessionId }),
								setPrivate: (sessionId, on) => rpc.send.privateToggled({ sessionId, on }),
								consent: (sessionId, answer, remember) => rpc.send.consentAnswered({ sessionId, answer, remember }),
								hoverBlock: (sessionId, id) => rpc.send.blockHovered({ sessionId, id }),
								pointerEntered: (sessionId) => rpc.send.livePointerEntered({ sessionId }),
								blurred: (sessionId) => rpc.send.liveBlurred({ sessionId }),
							}}
						/>
					)}
				</Show>
			)}
		</Show>
	),
	root,
);
