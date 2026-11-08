// GLIM-152: what the results layer draws in the DOM over its canvas boxes: a numbered badge on
// each box (the same number as its block in the Snip popup) and, in overlay mode, an opaque
// card with the translation fitted into the box (snip-popup.md §2.5, region-picker.md §2 L).
// Positions arrive global logical; this display's origin is subtracted. Text fitting is core's
// `fitText`, measured with a canvas in the card's own font stack (per-script, from `lang`).
import {
	BADGE_HIT_RADIUS,
	badgeAnchor,
	badgeLabel,
	type FitTextResult,
	fitText,
	type Rect,
	type ResultsCard,
	type ResultsLayerState,
} from "@glimpse/core";
import { createEffect, createSignal, For, type JSX, Show } from "solid-js";

/** Largest and smallest card text (px) before script scaling: the popup's translation size, and the floor. */
export const CARD_MAX_PX = 15;
export const CARD_MIN_PX = 11;
/** Widest a card may grow (px) to fit one long word in a narrow (vertical) box. */
export const CARD_MAX_WIDTH = 240;

let measureCtx: CanvasRenderingContext2D | null = null;
const measurer = (family: string) => {
	measureCtx ??= document.createElement("canvas").getContext("2d");
	return (text: string, px: number): number => {
		if (!measureCtx) return text.length * px * 0.55;
		measureCtx.font = `400 ${px}px ${family}`;
		return measureCtx.measureText(text).width;
	};
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function ResultsMarks(props: {
	results: ResultsLayerState;
	origin: { x: number; y: number };
	size: { width: number; height: number };
	/** The card or box under the pointer (this view's own hit test): its card steps aside. */
	hoverId: string | null;
}): JSX.Element {
	const local = (r: Rect): Rect => ({
		x: r.x - props.origin.x,
		y: r.y - props.origin.y,
		width: r.width,
		height: r.height,
	});
	const boxOf = (id: string) => props.results.boxes.find((b) => b.id === id)?.rect ?? null;
	const lit = (id: string) => props.results.linkedId === id || props.results.selectedId === id;
	const peek = (id: string) => !!props.results.overlay?.peek || props.hoverId === id;
	return (
		// The popup is the accessible surface for the same content; the marks are visual only.
		<div class="results-marks" data-overlay={props.results.overlay ? "" : undefined} aria-hidden="true">
			<Show when={props.results.overlay}>
				{(o) => (
					<For each={o().cards}>
						{(card) => (
							<Show when={boxOf(card.id)}>
								{(box) => (
									<Card card={card} box={local(box())} size={props.size} peek={peek(card.id)} linked={lit(card.id)} />
								)}
							</Show>
						)}
					</For>
				)}
			</Show>
			<For each={props.results.boxes.filter((b) => b.badge !== undefined)}>
				{(b) => {
					const at = () => {
						const a = badgeAnchor(local(b.rect), props.results.uiDir);
						// Keep the whole badge on this display.
						const r = BADGE_HIT_RADIUS - 2;
						return { x: clamp(a.x, r, props.size.width - r), y: clamp(a.y, r, props.size.height - r) };
					};
					return (
						<span
							class="results-badge"
							data-badge={b.id}
							data-lit={lit(b.id) ? "" : undefined}
							data-dashed={b.style === "dashed" ? "" : undefined}
							style={{ left: `${at().x}px`, top: `${at().y}px` }}
						>
							{badgeLabel(b.badge ?? 0)}
						</span>
					);
				}}
			</For>
		</div>
	);
}

function Card(props: {
	card: ResultsCard;
	box: Rect;
	size: { width: number; height: number };
	peek: boolean;
	linked: boolean;
}): JSX.Element {
	let el: HTMLDivElement | undefined;
	const [fit, setFit] = createSignal<FitTextResult | null>(null);
	createEffect(() => {
		const text = props.card.text;
		const box = props.box;
		const lang = props.card.lang ?? undefined;
		if (!el) return;
		// The card's own script stack, size step and leading (tokens.css :lang rules).
		const cs = getComputedStyle(el);
		const scale = Number.parseFloat(cs.getPropertyValue("--script-scale")) || 1;
		const leading = Number.parseFloat(cs.getPropertyValue("--leading-translation")) || 1.5;
		setFit(
			fitText(text, box, measurer(cs.fontFamily), {
				maxPx: CARD_MAX_PX * scale,
				minPx: CARD_MIN_PX * scale,
				lineHeight: leading,
				maxWidth: Math.min(CARD_MAX_WIDTH, props.size.width),
				...(lang ? { lang } : {}),
			}),
		);
	});
	const frame = () => {
		const f = fit();
		const w = f?.width ?? props.box.width;
		const h = f?.height ?? props.box.height;
		return {
			left: clamp(props.box.x + (f?.offsetX ?? 0), 0, Math.max(0, props.size.width - w)),
			top: clamp(props.box.y, 0, Math.max(0, props.size.height - h)),
			width: w,
			height: h,
		};
	};
	return (
		<div
			ref={el}
			class="results-card"
			data-card={props.card.id}
			data-peek={props.peek ? "" : undefined}
			data-linked={props.linked ? "" : undefined}
			data-grew={fit()?.grew ? "" : undefined}
			lang={props.card.lang ?? undefined}
			dir={props.card.dir}
			style={{
				left: `${frame().left}px`,
				top: `${frame().top}px`,
				width: `${frame().width}px`,
				height: `${frame().height}px`,
				visibility: fit() ? "visible" : "hidden",
			}}
		>
			<For each={fit()?.lines ?? []}>
				{(line) => (
					<span
						class="results-card-line"
						style={{ "font-size": `${fit()?.px ?? CARD_MAX_PX}px`, "line-height": `${fit()?.linePx ?? 22}px` }}
					>
						{line}
					</span>
				)}
			</For>
		</div>
	);
}
