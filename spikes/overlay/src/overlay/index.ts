// Overlay webview: one per display. Draws the dim, the selection hole, the
// crosshair, the live size readout and a thin edge frame (to eyeball that the
// window covers the whole display). All selection state comes from Bun.

import { Electroview } from "electrobun/view";
import type { OverlayRPC, OverlayState, ViewInit } from "../shared/rpc";

const params = new URLSearchParams(location.search);
const displayId = Number(params.get("display") ?? "0");

const canvas = document.getElementById("c") as HTMLCanvasElement;
const banner = document.getElementById("banner") as HTMLDivElement;
const ctx = canvas.getContext("2d")!;

let init: ViewInit | null = null;
let state: OverlayState | null = null;
let localCursor: { x: number; y: number } | null = null;
let dirty = true;
const rtts: number[] = [];

const rpc = Electroview.defineRPC<OverlayRPC>({
	maxRequestTime: 10_000,
	handlers: {
		requests: {},
		messages: {
			state: (s: OverlayState) => {
				state = s;
				if (s.echo && s.echo.displayId === displayId) {
					rtts.push(performance.now() - s.echo.t);
					if (rtts.length > 60) rtts.shift();
				}
				dirty = true;
			},
			reset: () => {
				state = null;
				dirty = true;
			},
		},
	},
});
new Electroview({ rpc });

function resize(): void {
	const dpr = window.devicePixelRatio || 1;
	canvas.width = Math.round(window.innerWidth * dpr);
	canvas.height = Math.round(window.innerHeight * dpr);
	dirty = true;
}
window.addEventListener("resize", resize);
resize();

function sendPointer(phase: "down" | "move" | "up" | "leave", e: PointerEvent): void {
	rpc.send.pointer({ displayId, phase, x: e.clientX, y: e.clientY, buttons: e.buttons, t: performance.now() });
}

canvas.addEventListener("pointerdown", (e) => {
	if (e.button !== 0) return;
	canvas.setPointerCapture(e.pointerId);
	localCursor = { x: e.clientX, y: e.clientY };
	sendPointer("down", e);
	e.preventDefault();
});
canvas.addEventListener("pointermove", (e) => {
	localCursor = { x: e.clientX, y: e.clientY };
	dirty = true;
	sendPointer("move", e);
});
canvas.addEventListener("pointerup", (e) => {
	if (e.button !== 0) return;
	sendPointer("up", e);
	if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener("pointerleave", (e) => {
	localCursor = null;
	dirty = true;
	sendPointer("leave", e);
});
window.addEventListener("contextmenu", (e) => e.preventDefault());

window.addEventListener("keydown", (e) => {
	const handled = ["Escape", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab"];
	if (handled.includes(e.key)) e.preventDefault();
	rpc.send.key({ displayId, key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey });
});
window.addEventListener("focus", () => rpc.send.focus({ displayId, focused: true }));
window.addEventListener("blur", () => rpc.send.focus({ displayId, focused: false }));

function draw(): void {
	const dpr = window.devicePixelRatio || 1;
	const w = window.innerWidth;
	const h = window.innerHeight;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, w, h);

	const origin = init?.origin ?? { x: 0, y: 0 };
	const sel = state?.selection
		? { x: state.selection.x - origin.x, y: state.selection.y - origin.y, width: state.selection.width, height: state.selection.height }
		: null;

	// Dim everywhere, then punch the selection out.
	ctx.fillStyle = `rgba(0, 0, 0, ${init?.dimAlpha ?? 0.35})`;
	ctx.fillRect(0, 0, w, h);
	if (sel && sel.width > 0 && sel.height > 0) {
		ctx.clearRect(sel.x, sel.y, sel.width, sel.height);
		const px = 1 / dpr;
		ctx.lineWidth = px;
		ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
		ctx.strokeRect(sel.x - px, sel.y - px, sel.width + 2 * px, sel.height + 2 * px);
		ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
		ctx.strokeRect(sel.x + px / 2, sel.y + px / 2, sel.width - px, sel.height - px);
	}

	// Edge frame: 2 CSS px inside every edge, so a missing edge is obvious.
	ctx.strokeStyle = "rgba(64, 156, 255, 0.9)";
	ctx.lineWidth = 2;
	ctx.strokeRect(1, 1, w - 2, h - 2);

	// Crosshair: local pointer if we have one, else the Bun-reported global cursor.
	let c = localCursor;
	if (!c && state?.cursor) {
		const lc = { x: state.cursor.x - origin.x, y: state.cursor.y - origin.y };
		if (lc.x >= 0 && lc.y >= 0 && lc.x < w && lc.y < h) c = lc;
	}
	if (c) {
		const px = 1 / dpr;
		const cx = Math.round(c.x * dpr) / dpr + px / 2;
		const cy = Math.round(c.y * dpr) / dpr + px / 2;
		ctx.lineWidth = px;
		ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
		ctx.beginPath();
		ctx.moveTo(0, cy);
		ctx.lineTo(w, cy);
		ctx.moveTo(cx, 0);
		ctx.lineTo(cx, h);
		ctx.stroke();
	}

	// Live size readout, on the display under the cursor only.
	if (state?.label && state.labelDisplayId === displayId && c) {
		ctx.font = "12px system-ui, -apple-system, 'Segoe UI', sans-serif";
		const text = state.label;
		const tw = ctx.measureText(text).width;
		let lx = c.x + 14;
		let ly = c.y + 18;
		if (lx + tw + 12 > w) lx = c.x - tw - 26;
		if (ly + 22 > h) ly = c.y - 30;
		ctx.fillStyle = "rgba(20, 20, 24, 0.85)";
		ctx.fillRect(lx, ly, tw + 12, 20);
		ctx.fillStyle = "#fff";
		ctx.fillText(text, lx + 6, ly + 14);
	}

	const avg = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;
	banner.textContent =
		`Glimpse overlay spike · display ${displayId} · ${w}×${h} @${dpr}x` +
		(init ? ` (expected @${init.scaleFactor}x${init.isPrimary ? ", primary" : ""})` : "") +
		` · drag to select · Esc cancels` +
		(avg !== null ? ` · RPC rtt ${avg.toFixed(1)} ms` : "");
}

function frame(): void {
	if (dirty) {
		dirty = false;
		draw();
	}
	requestAnimationFrame(frame);
}

async function start(): Promise<void> {
	window.focus();
	init = await rpc.request.hello({
		displayId,
		devicePixelRatio: window.devicePixelRatio,
		innerWidth: window.innerWidth,
		innerHeight: window.innerHeight,
		screenX: window.screenX,
		screenY: window.screenY,
		userAgent: navigator.userAgent,
		hasFocus: document.hasFocus(),
	});
	dirty = true;
}

requestAnimationFrame(frame);
start().catch((err) => {
	banner.textContent = `Glimpse overlay spike · RPC hello failed: ${String(err)}`;
});
