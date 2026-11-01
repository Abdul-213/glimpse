// One display's picker overlay (region-picker spec 2, 9.4). Thin: it renders the state
// main pushes and sends raw input back. All positions arrive global logical and are drawn
// relative to this display's origin.
import type { PickerMode, PickerViewState } from "@glimpse/core";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type {
	PickerKeyMessage,
	PickerLoupeMessage,
	PickerModifiers,
	PickerOpenInfo,
	PickerPointerMessage,
	PickerViewInit,
} from "../../shared/rpc.ts";
import { A11Y_OPEN, a11yBox, a11yLabel, hintParts, keyLabel, MODE_LABEL, REPLACES_LIVE } from "./copy.ts";
import { decodeBase64, drawLoupe, drawOverlay, type Palette, readPalette } from "./draw.ts";

export interface PickerInput {
	pointer(m: PickerPointerMessage): void;
	key(m: PickerKeyMessage): void;
	focus(focused: boolean): void;
	modeClicked(mode: PickerMode): void;
	hintHover(over: boolean): void;
	measured(m: {
		hint?: { width: number; height: number };
		readout?: { text: string; width: number; height: number };
	}): void;
}

export interface PickerStore {
	open: () => PickerOpenInfo | null;
	state: () => PickerViewState | null;
	loupe: () => PickerLoupeMessage | null;
	hidden: () => { animate: boolean } | null;
}

const LOUPE_CELLS = 15;
const mods = (e: MouseEvent | KeyboardEvent): PickerModifiers => ({
	shift: e.shiftKey,
	alt: e.altKey,
	ctrl: e.ctrlKey,
	meta: e.metaKey,
});

export function PickerOverlay(props: { init: PickerViewInit; store: PickerStore; input: PickerInput }) {
	const init = props.init;
	const s = () => props.store.state();
	const mine = (id: number | null | undefined) => id === init.displayId;
	let root: HTMLDivElement | undefined;
	let canvas: HTMLCanvasElement | undefined;
	let loupeCanvas: HTMLCanvasElement | undefined;
	let hintEl: HTMLDivElement | undefined;
	let readoutEl: HTMLDivElement | undefined;
	let palette: Palette | null = null;
	const [level, setLevel] = createSignal<0 | 1 | 2>(0);
	const [announce, setAnnounce] = createSignal("");
	const dpr = () => window.devicePixelRatio || init.scaleFactor || 1;
	const local = (p: { x: number; y: number }) => ({ x: p.x - init.origin.x, y: p.y - init.origin.y });

	// Canvas: redraw once per animation frame with the newest state.
	let frame = 0;
	const paint = () => {
		frame = 0;
		const state = s();
		const ctx = canvas?.getContext("2d");
		if (!ctx || !canvas || !root) return;
		palette ??= readPalette(root);
		const w = window.innerWidth;
		const h = window.innerHeight;
		const ratio = dpr();
		if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
			canvas.width = Math.round(w * ratio);
			canvas.height = Math.round(h * ratio);
		}
		if (!state || props.store.hidden()?.animate === false) {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			return;
		}
		drawOverlay(ctx, { width: w, height: h }, ratio, init.origin, init.displayId, state, palette);
	};
	createEffect(() => {
		s();
		props.store.hidden();
		if (!frame) frame = requestAnimationFrame(paint);
	});

	createEffect(() => {
		const msg = props.store.loupe();
		const ctx = loupeCanvas?.getContext("2d");
		if (!ctx || !loupeCanvas || !root) return;
		palette ??= readPalette(root);
		const ratio = dpr();
		const px = LOUPE_CELLS * 8;
		if (loupeCanvas.width !== px * ratio) {
			loupeCanvas.width = px * ratio;
			loupeCanvas.height = px * ratio;
		}
		const rgba = msg && mine(msg.displayId) ? decodeBase64(msg.rgba) : null;
		drawLoupe(ctx, ratio, rgba, msg?.size ?? LOUPE_CELLS, palette);
	});

	// Opening: reset the copy level, take focus, announce.
	createEffect(() => {
		const open = props.store.open();
		if (!open) return;
		setLevel(0);
		root?.focus();
		setAnnounce(A11Y_OPEN);
	});

	// Hint overflow: long copy, then short, then no key chips (spec 4).
	createEffect(() => {
		s()?.hint?.key;
		s()?.mode;
		level();
		queueMicrotask(() => {
			if (!hintEl) return;
			const max = (s()?.hint?.maxWidth ?? 0) + 0.5;
			const natural = hintEl.scrollWidth;
			if (natural > max && level() < 2 && max > 0.5) setLevel((l) => (l + 1) as 0 | 1 | 2);
			props.input.measured({ hint: { width: natural, height: hintEl.offsetHeight } });
		});
	});

	createEffect(() => {
		const r = s()?.readout;
		if (!r || !mine(r.displayId)) return;
		queueMicrotask(() => {
			if (readoutEl)
				props.input.measured({
					readout: { text: r.text, width: readoutEl.offsetWidth, height: readoutEl.offsetHeight },
				});
		});
	});

	// Debounced keyboard announcements of the box (spec 12).
	let boxTimer: ReturnType<typeof setTimeout> | undefined;
	createEffect(() => {
		const state = s();
		if (!state?.selection || state.phase !== "adjusting") return;
		const sel = state.selection;
		clearTimeout(boxTimer);
		boxTimer = setTimeout(() => setAnnounce(a11yBox(sel)), 500);
	});
	let lastMode: PickerMode | null = null;
	createEffect(() => {
		const m = s()?.mode;
		if (m && lastMode && m !== lastMode) setAnnounce(`${MODE_LABEL[m]} mode`);
		lastMode = m ?? null;
	});

	const pointer = (phase: PickerPointerMessage["phase"]) => (e: PointerEvent) => {
		if (phase === "down") {
			root?.setPointerCapture(e.pointerId);
			root?.focus();
		}
		if (phase === "up" && root?.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
		props.input.pointer({
			displayId: init.displayId,
			phase,
			x: e.clientX,
			y: e.clientY,
			button: e.button,
			detail: phase === "move" ? 0 : e.detail || 1,
			mods: mods(e),
		});
	};

	const onKey = (down: boolean) => (e: KeyboardEvent) => {
		const handled = ["Tab", "Enter", "Escape", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
		if (handled.includes(e.key)) e.preventDefault();
		props.input.key({ displayId: init.displayId, key: e.key, down, repeat: e.repeat, mods: mods(e) });
	};

	onMount(() => {
		const kd = onKey(true);
		const ku = onKey(false);
		const fo = () => props.input.focus(true);
		const bl = () => props.input.focus(false);
		window.addEventListener("keydown", kd);
		window.addEventListener("keyup", ku);
		window.addEventListener("focus", fo);
		window.addEventListener("blur", bl);
		const rs = () => {
			if (!frame) frame = requestAnimationFrame(paint);
		};
		window.addEventListener("resize", rs);
		onCleanup(() => {
			window.removeEventListener("keydown", kd);
			window.removeEventListener("keyup", ku);
			window.removeEventListener("focus", fo);
			window.removeEventListener("blur", bl);
			window.removeEventListener("resize", rs);
		});
	});

	const opacity = () => {
		const hidden = props.store.hidden();
		return hidden || !props.store.open() ? 0 : 1;
	};
	const osReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
	const fadeMs = () => {
		// Reduced motion: Glimpse's own setting (data-motion) or the OS's (spec 8).
		if (
			osReducedMotion ||
			props.store.open()?.reducedMotion ||
			document.documentElement.dataset["motion"] === "reduced"
		)
			return 0;
		return props.store.hidden() ? 80 : 100;
	};

	return (
		<div
			ref={root}
			class="picker-root"
			role="application"
			aria-roledescription="area picker"
			aria-label={a11yLabel(s()?.mode ?? props.store.open()?.mode ?? "snip")}
			tabIndex={-1}
			style={{
				cursor: s()?.cursorStyle ?? "crosshair",
				opacity: opacity(),
				"transition-property": "opacity",
				"transition-duration": `${fadeMs()}ms`,
				"transition-timing-function": props.store.hidden() ? "var(--ease-exit)" : "var(--ease-out)",
			}}
			onPointerDown={pointer("down")}
			onPointerMove={pointer("move")}
			onPointerUp={pointer("up")}
			onPointerLeave={pointer("leave")}
			onContextMenu={(e) => e.preventDefault()}
			onWheel={(e) => e.preventDefault()}
		>
			<canvas ref={canvas} class="picker-canvas" />

			<Show when={s()?.loupe && mine(s()?.loupe?.displayId) ? s()?.loupe : null}>
				{(l) => (
					<div
						class="picker-loupe rounded-popup"
						style={{ left: `${local(l().at).x}px`, top: `${local(l().at).y}px` }}
						aria-hidden="true"
					>
						<canvas ref={loupeCanvas} class="picker-loupe-canvas" />
					</div>
				)}
			</Show>

			<Show when={s()?.readout && mine(s()?.readout?.displayId) ? s()?.readout : null}>
				{(r) => (
					<div
						ref={readoutEl}
						class="picker-hud picker-readout rounded-kbd text-numeric"
						style={{ left: `${local(r().at).x}px`, top: `${local(r().at).y}px` }}
						aria-hidden="true"
					>
						{r().text}
					</div>
				)}
			</Show>

			<Show when={s()?.hint && mine(s()?.hint?.displayId) ? s()?.hint : null}>
				{(h) => (
					<div
						ref={hintEl}
						class="picker-hud picker-hint rounded-control text-label"
						style={{
							left: `${local(h().rect).x + h().rect.width / 2}px`,
							top: `${local(h().rect).y}px`,
							"max-width": `${h().maxWidth}px`,
						}}
						onPointerEnter={() => props.input.hintHover(true)}
						onPointerLeave={() => props.input.hintHover(false)}
						onPointerDown={(e) => e.stopPropagation()}
						onPointerUp={(e) => e.stopPropagation()}
					>
						<fieldset class="picker-modes" aria-label="Mode">
							<For each={["snip", "live"] as const}>
								{(m) => (
									<button
										type="button"
										aria-pressed={s()?.mode === m}
										class="picker-mode rounded-kbd"
										classList={{ "picker-mode-on": s()?.mode === m }}
										tabIndex={-1}
										onClick={() => props.input.modeClicked(m)}
									>
										{MODE_LABEL[m]}
									</button>
								)}
							</For>
						</fieldset>
						<For each={hintParts(h().key, s()?.mode ?? "snip", level())}>
							{(p) =>
								"key" in p ? (
									<span class="picker-keypair">
										<kbd class="picker-kbd rounded-kbd">{keyLabel(p.key, init.os)}</kbd>
										<span class="picker-secondary">{p.action}</span>
									</span>
								) : (
									<span>{p.text}</span>
								)
							}
						</For>
						<Show when={h().egress}>
							<span class="picker-egress">
								<svg class="picker-icon" viewBox="0 0 16 16" aria-hidden="true">
									<path
										d="M4.5 12.5h7a3 3 0 0 0 .4-6A4 4 0 0 0 4.2 7.6 2.5 2.5 0 0 0 4.5 12.5z"
										fill="none"
										stroke="currentColor"
										stroke-width="1.5"
										stroke-linejoin="round"
									/>
								</svg>
								{h().egress}
							</span>
						</Show>
						<Show when={h().replacesLive}>
							<span class="picker-secondary">{REPLACES_LIVE}</span>
						</Show>
					</div>
				)}
			</Show>

			<div class="picker-sr" role="status" aria-live="polite">
				{announce()}
			</div>
		</div>
	);
}
