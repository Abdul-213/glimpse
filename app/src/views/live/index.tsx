// Docked Live popup view entry (GLIM-79). Loaded hidden at launch into the pre-created Live
// window; main pushes `liveState`, the view renders it in place and sends intents back.
import { applyPlatform } from "@glimpse/ui";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import type { LiveRPC, LiveStateMessage, LiveViewInit } from "../../shared/live-rpc.ts";
import { connect } from "../rpc.ts";
import { moveAnnouncement } from "./copy.ts";
import { type LiveAnnouncement, LivePopup } from "./LivePopup.tsx";

const [init, setInit] = createSignal<LiveViewInit | null>(null);
const [message, setMessage] = createSignal<LiveStateMessage | null>(null);
const [announcements, setAnnouncements] = createSignal<readonly LiveAnnouncement[]>([]);
let announcementId = 0;

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
		// GLIM-92: one coalesced announcement; the log keeps its last 5 entries.
		liveAnnounce: (m) => {
			if (message()?.sessionId !== m.sessionId) return;
			setAnnouncements((list) => [...list, { id: ++announcementId, text: m.text, kind: m.kind }].slice(-10));
		},
		// GLIM-151: a keyboard move or Dock, into the polite role="status" region.
		liveMoved: (m) => {
			if (message()?.sessionId !== m.sessionId) return;
			const text = moveAnnouncement(m.kind, m.edges);
			setAnnouncements((list) => [...list, { id: ++announcementId, text, kind: "status" as const }].slice(-10));
		},
	},
});

document.addEventListener("contextmenu", (e) => e.preventDefault());

rpc.request
	.getLiveInit()
	.then((i) => {
		// data-material (native / none) and data-theme come from the window's chrome
		// (window-chrome.ts, GLIM-132): the solid veil until it says a material is behind the webview.
		applyPlatform(i.os);
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
							announcements={announcements()}
							intents={{
								painted: (sessionId) => rpc.send.livePainted({ sessionId }),
								resized: (sessionId, contentHeight) => rpc.send.liveResized({ sessionId, contentHeight }),
								pause: (sessionId) => rpc.send.pauseRequested({ sessionId }),
								resume: (sessionId) => rpc.send.resumeRequested({ sessionId }),
								stop: (sessionId) => rpc.send.stopRequested({ sessionId }),
								repin: (sessionId) => rpc.send.repinRequested({ sessionId }),
								continueCloud: (sessionId) => rpc.send.continueCloudRequested({ sessionId }),
								setPrivate: (sessionId, on) => rpc.send.privateToggled({ sessionId, on }),
								consent: (sessionId, answer, remember) => rpc.send.consentAnswered({ sessionId, answer, remember }),
								hoverBlock: (sessionId, id) => rpc.send.blockHovered({ sessionId, id }),
								pointerEntered: (sessionId) => rpc.send.livePointerEntered({ sessionId }),
								blurred: (sessionId) => rpc.send.liveBlurred({ sessionId }),
								copy: (sessionId, what) => rpc.send.copyRequested({ sessionId, what }),
								skipped: (sessionId, expanded) => rpc.send.skippedToggled({ sessionId, expanded }),
								downloadPack: (sessionId, lang) => rpc.send.downloadPack({ sessionId, lang }),
								skippedAction: (sessionId, action) => rpc.send.skippedAction({ sessionId, action }),
								dragStart: (sessionId) => rpc.send.liveDragStart({ sessionId }),
								dragMove: (sessionId, dx, dy) => rpc.send.liveDragMove({ sessionId, dx, dy }),
								dragEnd: (sessionId) => rpc.send.liveDragEnd({ sessionId }),
								move: (sessionId, direction, large) => rpc.send.moveRequested({ sessionId, direction, large }),
								dock: (sessionId) => rpc.send.dockRequested({ sessionId }),
								setPinned: (sessionId, on) => rpc.send.pinToggled({ sessionId, on }),
							}}
						/>
					)}
				</Show>
			)}
		</Show>
	),
	root,
);
