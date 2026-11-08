// Browser preview of the docked Live popup (dev tool, not shipped): the real LivePopup view
// fed with scenario states (scenarios.ts) instead of RPC. Each frame plays the window: its
// height follows the view's `resized` report, capped at the layout's maxHeight.
// Build + serve: `bun app/scripts/live-shots.ts --serve`.
//
//   ?scenario=l4-changed (default: all)   ?os=macos|windows|win10   ?dir=rtl

import type { Rect } from "@glimpse/core";
import { applyPlatform } from "@glimpse/ui";
import { createSignal, For, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import { liveViewInit } from "../../src/bun/windows/live-popup-controller.ts";
import type { LiveMarkSprite } from "../../src/shared/live-rpc.ts";
import { LivePopup } from "../../src/views/live/LivePopup.tsx";
import { LIVE_SCENARIOS, type LiveScenario, liveScenarioMessage } from "./scenarios.ts";

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

function Frame(props: { scenario: LiveScenario; onMarks?: (sprites: LiveMarkSprite[]) => void }) {
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
					downloadPack: noop,
					...(props.onMarks ? { marks: (_id: string, sprites: LiveMarkSprite[]) => props.onMarks?.(sprites) } : {}),
				}}
			/>
		</div>
	);
}

/**
 * GLIM-154: the pinned region as it looks on screen: the page, the frame's corner ticks, and
 * the badges and cards exactly as the view hands them to the native frame (its bitmaps, at
 * their global rects). The popup sits at the region's inline-end side, 8px away.
 */
function Scene(props: { scenario: LiveScenario; region: Rect }) {
	const r = props.region;
	const images = new Map<string, ImageData>();
	const [sprites, setSprites] = createSignal<LiveMarkSprite[]>([]);
	const onMarks = (list: LiveMarkSprite[]) => {
		for (const s of list) {
			if (!s.image) continue;
			const bin = atob(s.image.data);
			const bytes = new Uint8ClampedArray(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			images.set(s.key, new ImageData(bytes, s.image.width, s.image.height));
		}
		setSprites(list);
	};
	const page = document.getElementById("comic-page") as HTMLImageElement | null;
	return (
		<div
			class="preview-scene"
			style={{ width: `${r.x + r.width + 8 + props.scenario.width + 40}px`, height: `${r.y + r.height + 40}px` }}
		>
			<img class="preview-page" src={page?.src ?? ""} alt="" style={{ left: `${r.x}px`, top: `${r.y}px` }} />
			<For each={["tl", "tr", "bl", "br"]}>
				{(c) => <span class="preview-tick" data-corner={c} style={tickStyle(r, c)} />}
			</For>
			<For each={sprites()}>
				{(s) => {
					let canvas: HTMLCanvasElement | undefined;
					onMount(() => {
						const img = images.get(s.key);
						if (!canvas || !img) return;
						canvas.width = img.width;
						canvas.height = img.height;
						canvas.getContext("2d")?.putImageData(img, 0, 0);
					});
					return (
						<canvas
							ref={canvas}
							class="preview-sprite"
							style={{
								left: `${s.x}px`,
								top: `${s.y}px`,
								width: `${s.width}px`,
								height: `${s.height}px`,
								opacity: s.opacity,
							}}
						/>
					);
				}}
			</For>
			<div class="preview-docked" style={{ left: `${r.x + r.width + 8}px`, top: `${r.y}px` }}>
				<Frame scenario={props.scenario} onMarks={onMarks} />
			</div>
		</div>
	);
}

/** The frame's L ticks (live-popup.md §2.4): 12px arms, 2px, 1px outside the region. */
function tickStyle(r: Rect, corner: string): Record<string, string> {
	const off = 3;
	const left = corner.endsWith("l") ? r.x - off : r.x + r.width + off - 12;
	const top = corner.startsWith("t") ? r.y - off : r.y + r.height + off - 12;
	return { left: `${left}px`, top: `${top}px` };
}

const root = document.getElementById("root");
if (!root) throw new Error("preview: #root missing");
render(
	() => (
		<div class="preview-stage">
			<For each={list}>
				{(s) => (
					<Show when={s.scene} fallback={<Frame scenario={s} />}>
						{(scene) => <Scene scenario={s} region={scene().region} />}
					</Show>
				)}
			</For>
		</div>
	),
	root,
);
