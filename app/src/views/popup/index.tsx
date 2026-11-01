// Snip popup view entry (GLIM-65). Loaded hidden at launch into the pre-created popup
// window; main pushes `snipState`, the view renders it and sends intents back.
import { applyPlatform } from "@glimpse/ui";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import type { SnipPopupRPC, SnipStateMessage, SnipViewInit } from "../../shared/popup-rpc.ts";
import { connect } from "../rpc.ts";
import { SnipPopup } from "./SnipPopup.tsx";

const [init, setInit] = createSignal<SnipViewInit | null>(null);
const [message, setMessage] = createSignal<SnipStateMessage | null>(null);

const rpc = connect<SnipPopupRPC>({
	requests: {},
	messages: {
		snipState: (m) => {
			document.documentElement.dataset["motion"] = m.reducedMotion ? "reduced" : "full";
			setMessage(m);
		},
	},
});

// The webview's default context menu is off (§5: right-click does nothing in v1).
document.addEventListener("contextmenu", (e) => e.preventDefault());

rpc.request
	.getSnipInit()
	.then((i) => {
		// Solid veil until native materials are wired (popup.ts).
		applyPlatform(i.os, { material: "none" });
		document.documentElement.lang = i.uiLang;
		document.documentElement.dir = i.uiDir;
		setInit(i);
	})
	.catch(() => {});

const root = document.getElementById("root");
if (!root) throw new Error("popup: #root missing from index.html");

render(
	() => (
		<Show when={init()}>
			{(i) => (
				<Show when={message()}>
					{(m) => (
						<SnipPopup
							init={i()}
							message={m()}
							intents={{
								painted: (requestId) => rpc.send.snipPainted({ requestId }),
								resized: (requestId, contentHeight) => rpc.send.snipResized({ requestId, contentHeight }),
								dismiss: (requestId, reason) => rpc.send.snipDismiss({ requestId, reason }),
								skipped: (requestId, expanded) => rpc.send.snipSkipped({ requestId, expanded }),
								action: (requestId, action, lang) =>
									rpc.send.snipAction({ requestId, action, ...(lang ? { lang } : {}) }),
								retryBlock: (requestId, blockId) => rpc.send.snipRetryBlock({ requestId, blockId }),
							}}
						/>
					)}
				</Show>
			)}
		</Show>
	),
	root,
);
