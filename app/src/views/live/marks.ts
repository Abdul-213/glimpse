// GLIM-154: the Live view rasterises what the pinned frame paints over the region
// (live-popup.md §2.6): a numbered badge on each block's box and, in overlay mode, an opaque
// card with the translation fitted into its box (core `fitText`, measured with a canvas in the
// card's own script stack, as Snip's results layer does). The native frame window has no
// webview (it must be click-through and capture-excluded, §12.2), so it gets bitmaps: each
// mark is drawn once into a canvas at the region's display scale and sent to main with a
// global rect. A mark whose look didn't change keeps its key and is not drawn or sent again,
// so a Live update re-renders only the cards that changed.
//
// The look is Snip's (snip-popup.md §2.3, §2.5): badges are HUD pills ringed in
// picker-stroke, accent when lit; cards are surface-popup-solid with text-primary, a
// border-hairline edge, the Tooltip shadow and rounded.control, ringed 2px accent when lit.
// Live adds the change mark (and resting change tint) on cards in the latest change set.
import {
	badgeAnchor,
	badgeLabel,
	CARD_MAX_PX,
	CARD_MAX_WIDTH,
	CARD_MIN_PX,
	fitText,
	LIVE_CARD_PEEK_OPACITY,
	LIVE_MARKS_MARGIN,
	LIVE_MARKS_STALE_OPACITY,
	type LiveMarkBadge,
	type LiveMarkCard,
	type LiveMarks,
	type Rect,
} from "@glimpse/core";
import type { LiveMarkSprite } from "../../shared/live-rpc.ts";

/** Badge: a 20px pill, at least 20 wide, 6px inline padding (box-badge). */
const BADGE_H = 20;
const BADGE_PAD_X = 6;
/** Room around a sprite for its shadow and rings. */
const BADGE_BLEED = 6;
const CARD_BLEED = 11;
/** Card padding (4px 6px, as Snip). */
const CARD_PAD_X = 6;
const CARD_PAD_Y = 4;
/** The change mark on a card: 6px, inset 5px from its top inline-end corner. */
const MARK_D = 6;
const MARK_INSET = 5;

/** Resolved colours, type and radii from the view's own tokens (theme and OS accent included). */
export interface MarkTheme {
	readonly key: string;
	readonly hud: string;
	readonly hudText: string;
	readonly stroke: string;
	readonly hudShadow: string;
	readonly accent: string;
	readonly onAccent: string;
	readonly surface: string;
	readonly text: string;
	readonly edge: string;
	readonly shadow: string;
	readonly changeRest: string;
	readonly changeMark: string;
	readonly radiusControl: number;
	readonly numericFont: string;
	readonly translationWeight: string;
}

/** Card text for a language: its script stack, size step and leading (tokens.css `:lang()`). */
export interface CardType {
	readonly family: string;
	readonly scale: number;
	readonly leading: number;
}

export interface MarkContext {
	readonly region: Rect;
	readonly uiDir: "ltr" | "rtl";
	readonly uiLang: string;
	/** Sprite pixels per logical px (the region's display). */
	readonly scale: number;
	/** Original view: every card peeks (the source shows). */
	readonly peekAll: boolean;
	readonly theme: MarkTheme;
	readonly cardType: (lang: string | null) => CardType;
	readonly measure: (text: string, px: number, family: string, weight: string) => number;
}

/** One mark ready to rasterise: where it goes (global logical, bleed included) and how to draw it. */
export interface PlannedMark {
	readonly key: string;
	readonly id: string;
	readonly kind: "badge" | "card";
	readonly rect: Rect;
	readonly opacity: number;
	readonly paint: (ctx: CanvasRenderingContext2D) => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Where marks may go: the frame window (the region plus its margin). */
function bounds(region: Rect): Rect {
	const m = LIVE_MARKS_MARGIN;
	return { x: region.x - m, y: region.y - m, width: region.width + 2 * m, height: region.height + 2 * m };
}

/** Cards first, badges on top (they sit on the cards' corners), in reading order. */
export function planMarks(marks: LiveMarks, c: MarkContext): PlannedMark[] {
	const stale = marks.stale ? LIVE_MARKS_STALE_OPACITY : 1;
	return [
		...marks.cards.map((card) => planCard(card, c, c.peekAll ? LIVE_CARD_PEEK_OPACITY : stale)),
		...marks.badges.map((b) => planBadge(b, c, stale)),
	];
}

function planBadge(b: LiveMarkBadge, c: MarkContext, opacity: number): PlannedMark {
	const t = c.theme;
	const label = badgeLabel(b.n, c.uiLang);
	const textW = c.measure(label, 12, t.numericFont, "500");
	const w = Math.max(BADGE_H, Math.ceil(textW + 2 * BADGE_PAD_X));
	const a = badgeAnchor(b.rect, c.uiDir);
	const box = bounds(c.region);
	const x = clamp(a.x - w / 2, box.x, box.x + box.width - w);
	const y = clamp(a.y - BADGE_H / 2, box.y, box.y + box.height - BADGE_H);
	const e = BADGE_BLEED;
	return {
		key: ["b", b.id, label, b.lit ? 1 : 0, w, c.scale, t.key].join("|"),
		id: b.id,
		kind: "badge",
		rect: { x: x - e, y: y - e, width: w + 2 * e, height: BADGE_H + 2 * e },
		// Skipped blocks' badges at 60 %, like their dashed box (lit ones at full strength).
		opacity: opacity * (b.dashed && !b.lit ? 0.6 : 1),
		paint: (ctx) => {
			const r = BADGE_H / 2;
			ctx.save();
			ctx.shadowColor = t.hudShadow;
			ctx.shadowBlur = 4;
			ctx.shadowOffsetY = 1;
			// The 1px picker-stroke ring, outside the pill.
			ctx.fillStyle = t.stroke;
			pill(ctx, e - 1, e - 1, w + 2, BADGE_H + 2, r + 1);
			ctx.fill();
			ctx.restore();
			ctx.globalCompositeOperation = "destination-out";
			pill(ctx, e, e, w, BADGE_H, r);
			ctx.fill();
			ctx.globalCompositeOperation = "source-over";
			ctx.fillStyle = b.lit ? t.accent : t.hud;
			pill(ctx, e, e, w, BADGE_H, r);
			ctx.fill();
			ctx.fillStyle = b.lit ? t.onAccent : t.hudText;
			ctx.font = `500 12px ${t.numericFont}`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillText(label, e + w / 2, e + BADGE_H / 2 + 0.5);
		},
	};
}

function planCard(card: LiveMarkCard, c: MarkContext, opacity: number): PlannedMark {
	const t = c.theme;
	const type = c.cardType(card.lang);
	const box = bounds(c.region);
	const measure = (s: string, px: number) => c.measure(s, px, type.family, t.translationWeight);
	const fit = fitText(card.text, card.rect, measure, {
		maxPx: CARD_MAX_PX * type.scale,
		minPx: CARD_MIN_PX * type.scale,
		lineHeight: type.leading,
		padX: CARD_PAD_X,
		padY: CARD_PAD_Y,
		maxWidth: Math.min(CARD_MAX_WIDTH, box.width),
		...(card.lang ? { lang: card.lang } : {}),
	});
	const w = fit.width;
	const h = Math.min(fit.height, box.height);
	const x = clamp(card.rect.x + fit.offsetX, box.x, box.x + box.width - w);
	const y = clamp(card.rect.y, box.y, box.y + box.height - h);
	const e = CARD_BLEED;
	return {
		key: [
			"c",
			card.id,
			card.text,
			card.lit ? 1 : 0,
			card.changed ? 1 : 0,
			Math.round(card.rect.width),
			Math.round(card.rect.height),
			card.dir,
			card.lang ?? "",
			c.scale,
			t.key,
		].join("|"),
		id: card.id,
		kind: "card",
		rect: { x: x - e, y: y - e, width: w + 2 * e, height: h + 2 * e },
		opacity,
		paint: (ctx) => {
			const r = t.radiusControl;
			ctx.save();
			ctx.shadowColor = t.shadow;
			ctx.shadowBlur = 8;
			ctx.shadowOffsetY = 2;
			// Edge: 1px border-hairline outside the card (2px accent when lit).
			const ring = card.lit ? 2 : 1;
			ctx.fillStyle = card.lit ? t.accent : t.edge;
			rounded(ctx, e - ring, e - ring, w + 2 * ring, h + 2 * ring, r + ring);
			ctx.fill();
			ctx.restore();
			ctx.globalCompositeOperation = "destination-out";
			rounded(ctx, e, e, w, h, r);
			ctx.fill();
			ctx.globalCompositeOperation = "source-over";
			ctx.fillStyle = t.surface;
			rounded(ctx, e, e, w, h, r);
			ctx.fill();
			if (card.changed) {
				// Live change rules: the resting tint (the frame never flashes) and the mark.
				ctx.fillStyle = t.changeRest;
				rounded(ctx, e, e, w, h, r);
				ctx.fill();
				const endX = card.dir === "rtl" ? e + MARK_INSET + MARK_D / 2 : e + w - MARK_INSET - MARK_D / 2;
				ctx.fillStyle = t.changeMark;
				ctx.beginPath();
				ctx.arc(endX, e + MARK_INSET + MARK_D / 2, MARK_D / 2, 0, Math.PI * 2);
				ctx.fill();
			}
			ctx.save();
			rounded(ctx, e, e, w, h, r);
			ctx.clip();
			ctx.fillStyle = t.text;
			ctx.font = `${t.translationWeight} ${fit.px}px ${type.family}`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.direction = card.dir;
			const top = e + (h - fit.lines.length * fit.linePx) / 2;
			fit.lines.forEach((line, i) => {
				ctx.fillText(line, e + w / 2, top + fit.linePx * (i + 0.5));
			});
			ctx.restore();
		},
	};
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	rounded(ctx, x, y, w, h, Math.min(r, h / 2, w / 2));
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	const rr = Math.max(0, Math.min(r, w / 2, h / 2));
	ctx.beginPath();
	ctx.moveTo(x + rr, y);
	ctx.arcTo(x + w, y, x + w, y + h, rr);
	ctx.arcTo(x + w, y + h, x, y + h, rr);
	ctx.arcTo(x, y + h, x, y, rr);
	ctx.arcTo(x, y, x + w, y, rr);
	ctx.closePath();
}

/** Draw a planned mark at `scale` (pixels per logical px): its canvas. */
export function drawMark(m: PlannedMark, scale: number): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.ceil(m.rect.width * scale));
	canvas.height = Math.max(1, Math.ceil(m.rect.height * scale));
	const ctx = canvas.getContext("2d");
	if (ctx) {
		ctx.scale(scale, scale);
		m.paint(ctx);
	}
	return canvas;
}

/** Straight-alpha RGBA of a canvas, base64 (what `liveMarks` carries to main). */
export function canvasPixels(canvas: HTMLCanvasElement): { width: number; height: number; data: string } {
	const ctx = canvas.getContext("2d");
	const img = ctx?.getImageData(0, 0, canvas.width, canvas.height);
	const bytes = img ? new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength) : new Uint8Array(0);
	let bin = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	return { width: canvas.width, height: canvas.height, data: btoa(bin) };
}

/**
 * The sprites to send for `planned`: every mark's place, plus pixels for the keys main
 * doesn't have yet (`sent`, updated in place: keys no longer used are dropped, as main drops
 * them).
 */
export function spriteMessages(planned: readonly PlannedMark[], scale: number, sent: Set<string>): LiveMarkSprite[] {
	const out: LiveMarkSprite[] = [];
	const used = new Set<string>();
	for (const m of planned) {
		used.add(m.key);
		const base = {
			key: m.key,
			id: m.id,
			kind: m.kind,
			x: m.rect.x,
			y: m.rect.y,
			width: m.rect.width,
			height: m.rect.height,
			opacity: m.opacity,
		};
		if (sent.has(m.key)) {
			out.push(base);
			continue;
		}
		out.push({ ...base, image: canvasPixels(drawMark(m, scale)) });
		sent.add(m.key);
	}
	for (const k of [...sent]) if (!used.has(k)) sent.delete(k);
	return out;
}

const probes = new Map<string, HTMLElement>();
let measureCtx: CanvasRenderingContext2D | null = null;

/** Hidden elements the tokens are read through ("theme": colours and radii; "type": card text). */
function probeEl(name: "theme" | "type"): HTMLElement {
	const known = probes.get(name);
	if (known?.isConnected) return known;
	const el = document.createElement("div");
	el.setAttribute("aria-hidden", "true");
	el.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;inset-block-start:-9999px";
	document.body.append(el);
	probes.set(name, el);
	return el;
}

/** A CSS colour expression resolved to what the canvas takes. */
function colorOf(css: string): string {
	const el = probeEl("theme");
	el.style.color = "";
	el.style.color = css;
	return getComputedStyle(el).color;
}

/** The view's tokens, resolved now (theme, forced colours and the OS accent included). */
export function readMarkTheme(): MarkTheme {
	const el = probeEl("theme");
	el.style.borderTopLeftRadius = "var(--radius-control)";
	el.style.fontWeight = "var(--text-translation--font-weight, 400)";
	const cs = getComputedStyle(el);
	const theme = {
		hud: colorOf("var(--color-picker-hud)"),
		hudText: colorOf("var(--color-picker-hud-text)"),
		stroke: colorOf("var(--color-picker-stroke)"),
		hudShadow: colorOf("#0000004d"),
		accent: colorOf("var(--color-accent)"),
		onAccent: colorOf("var(--color-on-accent)"),
		surface: colorOf("var(--color-surface-popup-solid)"),
		text: colorOf("var(--color-text-primary)"),
		edge: colorOf("var(--color-border-hairline)"),
		shadow: colorOf("light-dark(#00000026, #00000066)"),
		changeRest: colorOf("var(--color-change-rest)"),
		changeMark: colorOf("var(--color-change-mark)"),
		radiusControl: Number.parseFloat(cs.borderTopLeftRadius) || 6,
		numericFont: cs.fontFamily || "system-ui",
		translationWeight: cs.fontWeight || "400",
	};
	return { ...theme, key: hashOf(JSON.stringify(theme)) };
}

/** The card text type for `lang`: the stack, size step and leading the popup uses. */
export function cardTypeFor(lang: string | null): CardType {
	const el = probeEl("type");
	if (lang) el.setAttribute("lang", lang);
	else el.removeAttribute("lang");
	el.className = "glim-translation";
	const cs = getComputedStyle(el);
	return {
		family: cs.fontFamily || "system-ui",
		scale: Number.parseFloat(cs.getPropertyValue("--script-scale")) || 1,
		leading: Number.parseFloat(cs.getPropertyValue("--leading-translation")) || 1.5,
	};
}

/** Canvas `measureText` in the given font. */
export function measureText(text: string, px: number, family: string, weight: string): number {
	measureCtx ??= document.createElement("canvas").getContext("2d");
	if (!measureCtx) return text.length * px * 0.55;
	measureCtx.font = `${weight} ${px}px ${family}`;
	return measureCtx.measureText(text).width;
}

function hashOf(s: string): string {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return (h >>> 0).toString(36);
}
