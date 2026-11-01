// Canvas layer of one overlay (region-picker spec 2 A, B, D, E, G, H): scrim with a hole,
// selection edge, snap candidate, guides, handles and crosshair. Everything arrives in
// global logical px and is drawn in this display's local CSS px; the canvas backing store
// is devicePixelRatio times larger, so 1 CSS px strokes are 2 device px on Retina (4.2).
import type { PickerViewState, Rect, ResultsLayerState } from "@glimpse/core";

export interface Palette {
	scrim: string;
	stroke: string;
	halo: string;
	/** `box-linked-fill`: the box of the block hovered or focused in the Snip popup (GLIM-115). */
	linkedFill: string;
}

/** Read the DESIGN.md picker colours from the theme's CSS variables. */
export function readPalette(el: Element): Palette {
	const css = getComputedStyle(el);
	const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
	return {
		scrim: v("--color-picker-scrim", "#00000073"),
		stroke: v("--color-picker-stroke", "#FFFFFF"),
		halo: v("--color-picker-halo", "#00000099"),
		linkedFill: v("--color-box-linked-fill", "#0A63C93D"),
	};
}

const CROSSHAIR_GAP = 10;

export function drawOverlay(
	ctx: CanvasRenderingContext2D,
	size: { width: number; height: number },
	dpr: number,
	origin: { x: number; y: number },
	displayId: number,
	s: PickerViewState,
	pal: Palette,
): void {
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, size.width, size.height);
	const local = (r: Rect): Rect => ({ x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height });
	const hole = s.selection ?? s.candidate?.rect ?? null;

	if (s.scrim) {
		ctx.fillStyle = pal.scrim;
		ctx.beginPath();
		ctx.rect(0, 0, size.width, size.height);
		if (hole) {
			const h = local(hole);
			// Opposite winding cuts the hole (evenodd also works; this keeps it explicit).
			ctx.rect(h.x + h.width, h.y, -h.width, h.height);
		}
		ctx.fill("evenodd");
	}

	if (s.candidate && !s.selection) edge(ctx, local(s.candidate.rect), pal, 0.6);
	for (const g of s.guides) {
		line(ctx, g.x1 - origin.x, g.y1 - origin.y, g.x2 - origin.x, g.y2 - origin.y, pal, 0.6);
	}
	if (s.selection) edge(ctx, local(s.selection), pal, 1);
	if (s.handles && s.selection) handles(ctx, local(s.selection), pal);

	if (s.crosshair && s.cursor && s.pointerDisplayId === displayId) {
		const cx = Math.round(s.cursor.x - origin.x) + 0.5;
		const cy = Math.round(s.cursor.y - origin.y) + 0.5;
		line(ctx, 0, cy, cx - CROSSHAIR_GAP, cy, pal, 1);
		line(ctx, cx + CROSSHAIR_GAP, cy, size.width, cy, pal, 1);
		line(ctx, cx, 0, cx, cy - CROSSHAIR_GAP, pal, 1);
		line(ctx, cx, cy + CROSSHAIR_GAP, cx, size.height, pal, 1);
	}
}

/**
 * Detection boxes on the results layer (snip-popup.md §2.3): 1 px stroke + 1 px halo,
 * `rounded.box` (4 px); skipped blocks dashed 3/3 at 60 %; the linked box filled with
 * `box-linked-fill`. Neutral blocks never arrive (no box).
 */
export function drawResults(
	ctx: CanvasRenderingContext2D,
	origin: { x: number; y: number },
	results: ResultsLayerState,
	pal: Palette,
): void {
	for (const b of results.boxes) {
		const r = { x: b.rect.x - origin.x, y: b.rect.y - origin.y, width: b.rect.width, height: b.rect.height };
		ctx.save();
		ctx.globalAlpha = b.style === "dashed" ? 0.6 : 1;
		if (b.id === results.linkedId) {
			ctx.fillStyle = pal.linkedFill;
			ctx.beginPath();
			ctx.roundRect(r.x, r.y, r.width, r.height, 4);
			ctx.fill();
		}
		ctx.setLineDash(b.style === "dashed" ? [3, 3] : []);
		ctx.lineWidth = 3;
		ctx.strokeStyle = pal.halo;
		ctx.beginPath();
		ctx.roundRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.width - 1), Math.max(0, r.height - 1), 4);
		ctx.stroke();
		ctx.lineWidth = 1;
		ctx.strokeStyle = pal.stroke;
		ctx.stroke();
		ctx.restore();
	}
}

/** 1 px stroke with a 1 px halo on both sides. */
function line(
	ctx: CanvasRenderingContext2D,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	pal: Palette,
	alpha: number,
) {
	ctx.save();
	ctx.globalAlpha = alpha;
	ctx.lineWidth = 3;
	ctx.strokeStyle = pal.halo;
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.stroke();
	ctx.lineWidth = 1;
	ctx.strokeStyle = pal.stroke;
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.stroke();
	ctx.restore();
}

/** Selection edge: 1 px stroke just inside the rect, 1 px halo just outside (spec 2 D). */
function edge(ctx: CanvasRenderingContext2D, r: Rect, pal: Palette, alpha: number) {
	ctx.save();
	ctx.globalAlpha = alpha;
	ctx.lineWidth = 1;
	ctx.strokeStyle = pal.halo;
	ctx.strokeRect(r.x - 0.5, r.y - 0.5, r.width + 1, r.height + 1);
	ctx.strokeStyle = pal.stroke;
	ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.width - 1), Math.max(0, r.height - 1));
	ctx.restore();
}

function handles(ctx: CanvasRenderingContext2D, r: Rect, pal: Palette) {
	const pts: [number, number][] = [
		[r.x, r.y],
		[r.x + r.width, r.y],
		[r.x + r.width, r.y + r.height],
		[r.x, r.y + r.height],
	];
	if (r.width >= 48) pts.push([r.x + r.width / 2, r.y], [r.x + r.width / 2, r.y + r.height]);
	if (r.height >= 48) pts.push([r.x, r.y + r.height / 2], [r.x + r.width, r.y + r.height / 2]);
	for (const [x, y] of pts) {
		ctx.fillStyle = pal.halo;
		ctx.beginPath();
		ctx.roundRect(x - 5, y - 5, 10, 10, 3);
		ctx.fill();
		ctx.fillStyle = pal.stroke;
		ctx.beginPath();
		ctx.roundRect(x - 4, y - 4, 8, 8, 3);
		ctx.fill();
	}
}

/** The loupe: each device px an 8 x 8 cell, grid lines, centre cell outlined (spec 2 C). */
export function drawLoupe(
	ctx: CanvasRenderingContext2D,
	dpr: number,
	rgba: Uint8Array | null,
	cells: number,
	pal: Palette,
): void {
	const z = 8;
	const size = cells * z;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.fillStyle = "#000000";
	ctx.fillRect(0, 0, size, size);
	if (rgba && rgba.length >= cells * cells * 4) {
		for (let y = 0; y < cells; y++) {
			for (let x = 0; x < cells; x++) {
				const i = (y * cells + x) * 4;
				ctx.fillStyle = `rgb(${rgba[i]} ${rgba[i + 1]} ${rgba[i + 2]})`;
				ctx.fillRect(x * z, y * z, z, z);
			}
		}
	}
	ctx.save();
	ctx.globalAlpha = 0.25;
	ctx.strokeStyle = pal.halo;
	ctx.lineWidth = 1;
	ctx.beginPath();
	for (let i = 1; i < cells; i++) {
		ctx.moveTo(i * z + 0.5, 0);
		ctx.lineTo(i * z + 0.5, size);
		ctx.moveTo(0, i * z + 0.5);
		ctx.lineTo(size, i * z + 0.5);
	}
	ctx.stroke();
	ctx.restore();
	const c = Math.floor(cells / 2) * z;
	ctx.lineWidth = 1;
	ctx.strokeStyle = pal.halo;
	ctx.strokeRect(c - 0.5, c - 0.5, z + 1, z + 1);
	ctx.strokeStyle = pal.stroke;
	ctx.strokeRect(c + 0.5, c + 0.5, z - 1, z - 1);
}

export function decodeBase64(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
