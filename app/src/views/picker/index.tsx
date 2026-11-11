// Picker overlay view entry (GLIM-44). One instance per display, loaded hidden at launch;
// main pushes reset/state/loupe/hide, the view sends raw input back.

import type { PickerViewState, ResultsLayerState } from "@glimpse/core";
import { applyPlatform } from "@glimpse/ui";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import type { PickerLoupeMessage, PickerOpenInfo, PickerRPC, PickerViewInit } from "../../shared/rpc.ts";
import { connect } from "../rpc.ts";
import { PickerOverlay } from "./PickerOverlay.tsx";

const [open, setOpen] = createSignal<PickerOpenInfo | null>(null);
const [state, setState] = createSignal<PickerViewState | null>(null);
const [loupe, setLoupe] = createSignal<PickerLoupeMessage | null>(null);
const [hidden, setHidden] = createSignal<{ animate: boolean } | null>({ animate: false });
const [init, setInit] = createSignal<PickerViewInit | null>(null);
// Results layer under the Snip popup (GLIM-115): detection boxes and the linked one.
const [results, setResults] = createSignal<ResultsLayerState | null>(null);

const rpc = connect<PickerRPC>({
	requests: {},
	messages: {
		pickerReset: (info) => {
			setLoupe(null);
			setState(null);
			setResults(null);
			setHidden(null);
			setOpen(info);
			document.documentElement.dataset["motion"] = info.reducedMotion ? "reduced" : "full";
		},
		pickerState: (s) => {
			// Ignore stale frames (messages can overtake each other across reconnects).
			const prev = state();
			if (prev && s.seq < prev.seq && s.phase === prev.phase) return;
			setState(s);
		},
		pickerLoupe: (m) => setLoupe(m),
		pickerResults: (m) => {
			const r = m?.results ?? null;
			// The overlay cards' peek fade follows Glimpse's motion setting (GLIM-152).
			if (r?.reducedMotion !== undefined)
				document.documentElement.dataset["motion"] = r.reducedMotion ? "reduced" : "full";
			setResults(r);
		},
		pickerHide: (h) => {
			setHidden(h);
			setOpen(null);
			setResults(null);
		},
	},
});

const displayId = Number(new URLSearchParams(location.search).get("display") ?? "0");

const root = document.getElementById("root");
if (!root) throw new Error("picker: #root missing from index.html");

rpc.request
	.getPickerInit({
		displayId,
		devicePixelRatio: window.devicePixelRatio,
		innerWidth: window.innerWidth,
		innerHeight: window.innerHeight,
	})
	.then((i) => {
		if (!i) return;
		applyPlatform(i.os);
		document.documentElement.dir = i.uiDir;
		setInit(i);
	})
	.catch(() => {});

render(
	() => (
		<Show when={init()}>
			{(i) => (
				<PickerOverlay
					init={i()}
					store={{ open, state, loupe, hidden, results }}
					input={{
						pointer: (m) => rpc.send.pickerPointer(m),
						key: (m) => rpc.send.pickerKey(m),
						focus: (focused) => rpc.send.pickerFocus({ displayId: i().displayId, focused }),
						modeClicked: (mode) => rpc.send.pickerModeClicked({ mode }),
						hintHover: (over) => rpc.send.pickerHintHover({ displayId: i().displayId, over }),
						measured: (m) => rpc.send.pickerMeasured({ displayId: i().displayId, ...m }),
					}}
				/>
			)}
		</Show>
	),
	root,
);
