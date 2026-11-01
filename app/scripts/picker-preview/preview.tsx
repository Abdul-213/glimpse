// Browser preview of the picker overlay (dev tool, not shipped): the real PickerOverlay
// component driven by the real PickerSession, running in one page over a painted stand-in
// desktop (the mockup's three windows). Loupe pixels are sampled from that painted desktop,
// the way the app samples a capture frame. Build + serve: `bun app/scripts/picker-preview.ts`.
//
//   ?state=hover|drag|adjust|keyboard|tooSmall|live   scripted input for screenshots
//   ?os=macos|windows
import {
	type LoupePatch,
	NO_MODIFIERS,
	PickerSession,
	type PickerViewState,
	type Point,
	type ScreenWindow,
} from "@glimpse/core";
import { applyPlatform } from "@glimpse/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { PickerLoupeMessage, PickerOpenInfo, PickerViewInit } from "../../src/shared/rpc.ts";
import { PickerOverlay } from "../../src/views/picker/PickerOverlay.tsx";

const W = window.innerWidth;
const H = window.innerHeight;
const q = new URLSearchParams(location.search);
const os = q.get("os") === "macos" ? "macos" : "windows";
applyPlatform(os);

const WINDOWS: ScreenWindow[] = [
	{ rect: { x: 64, y: 92, width: 400, height: 520 }, pid: 1, z: 0, appName: "Messages" },
	{ rect: { x: 500, y: 64, width: 720, height: 420 }, pid: 2, z: 1, appName: "Safari" },
	{ rect: { x: 560, y: 440, width: 620, height: 250 }, pid: 3, z: 2, appName: "Preview" },
];

// The stand-in desktop: painted once, shown behind the transparent overlay, sampled by the loupe.
const desk = document.createElement("canvas");
desk.width = W;
desk.height = H;
desk.style.cssText = "position:fixed;inset:0;z-index:-1";
document.body.prepend(desk);
const g = desk.getContext("2d") as CanvasRenderingContext2D;
const grad = g.createLinearGradient(0, 0, W, H);
grad.addColorStop(0, "#8FB3D9");
grad.addColorStop(1, "#D7C6E8");
g.fillStyle = grad;
g.fillRect(0, 0, W, H);
g.fillStyle = "#F2F2F4E6";
g.fillRect(0, 0, W, 28);
for (const w of [...WINDOWS].reverse()) {
	const r = w.rect;
	g.fillStyle = "#FFFFFF";
	g.beginPath();
	g.roundRect(r.x, r.y, r.width, r.height, 10);
	g.fill();
	g.fillStyle = "#ECECEE";
	g.fillRect(r.x, r.y, r.width, 30);
	g.fillStyle = "#111111";
	g.font = "15px sans-serif";
	g.fillText(
		w.appName === "Messages" ? "¿Nos vemos a las ocho?" : "Gleis 7 · ICE 597 nach München",
		r.x + 24,
		r.y + 70,
	);
}

const display = {
	id: 1,
	bounds: { x: 0, y: 0, width: W, height: H },
	workArea: { x: 0, y: 28, width: W, height: H - 28 },
	scaleFactor: 1,
	isPrimary: true,
};
const pointer = { at: { x: W / 2, y: H / 2 } as Point, cursor: () => pointer.at, primaryDown: () => false };

const [state, setState] = createSignal<PickerViewState | null>(null);
const [loupe, setLoupe] = createSignal<PickerLoupeMessage | null>(null);
const [open] = createSignal<PickerOpenInfo | null>({
	mode: q.get("state") === "live" ? "live" : "snip",
	reducedMotion: true,
	showLoupe: true,
});
const [hidden] = createSignal<{ animate: boolean } | null>(null);
let seq = 0;
const toB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

const session = new PickerSession({
	env: { displays: [display], os, confirmOnRelease: true },
	mode: open()?.mode ?? "snip",
	probe: pointer,
	windows: { list: async () => WINDOWS },
	sampler: {
		async sample(c: Point, size: number): Promise<LoupePatch> {
			const half = Math.floor(size / 2);
			const data = g.getImageData(Math.floor(c.x) - half, Math.floor(c.y) - half, size, size).data;
			return { centre: c, displayId: 1, size, rgba: new Uint8Array(data), sequence: ++seq };
		},
		stop() {},
	},
	now: () => performance.now(),
	egress: (m) =>
		q.get("cloud")
			? m === "live"
				? "Live will send text to Google Cloud Translation"
				: "Text will be sent to Google Cloud Translation"
			: null,
	onView: setState,
	onLoupe: (p) => setLoupe({ seq: p.sequence, displayId: 1, size: p.size, rgba: toB64(p.rgba) }),
	onDone: (o) => console.log("outcome", JSON.stringify(o)),
});
session.start();
setInterval(() => session.tick(), 16);

const init: PickerViewInit = {
	displayId: 1,
	origin: { x: 0, y: 0 },
	size: { width: W, height: H },
	scaleFactor: 1,
	os,
	uiDir: "ltr",
};
const root = document.getElementById("root");
if (!root) throw new Error("no root");
render(
	() => (
		<PickerOverlay
			init={init}
			store={{ open, state, loupe, hidden }}
			input={{
				pointer: (m) => {
					pointer.at = { x: m.x, y: m.y };
					session.pointer(m);
				},
				key: (m) => session.key(m),
				focus: () => {},
				modeClicked: (m) => session.setMode(m),
				hintHover: (o) => session.hintHover(1, o),
				measured: (m) =>
					session.measured(1, {
						...(m.hint ? { hint: m.hint } : {}),
						...(m.readout
							? { readout: { text: m.readout.text, size: { width: m.readout.width, height: m.readout.height } } }
							: {}),
					}),
			}}
		/>
	),
	root,
);

// Scripted states for screenshots.
const p = (phase: "down" | "move" | "up", x: number, y: number, shift = false) => {
	pointer.at = { x, y };
	session.pointer({ displayId: 1, phase, x, y, button: 0, detail: 1, mods: { ...NO_MODIFIERS, shift } });
};
const k = (key: string, alt = false) =>
	session.key({ displayId: 1, key, down: true, repeat: false, mods: { ...NO_MODIFIERS, alt } });
setTimeout(() => {
	switch (q.get("state")) {
		case "hover":
			p("move", 205, 152);
			break;
		case "drag":
			p("move", 67, 130);
			p("down", 67, 130);
			p("move", 200, 250);
			p("move", 436, 343);
			break;
		case "adjust":
			p("down", 500, 100);
			p("move", 800, 200);
			p("move", 1100, 250);
			p("up", 1100, 250, true);
			p("move", 900, 420);
			break;
		case "keyboard":
			k("ArrowRight");
			k("ArrowDown", true);
			break;
		case "tooSmall":
			p("down", 300, 300);
			p("move", 305, 340);
			p("up", 305, 340);
			break;
		case "live":
			p("move", 1000, 300);
			break;
	}
}, 50);
