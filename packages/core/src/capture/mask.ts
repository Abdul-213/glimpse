// GLIM-98: keep Glimpse's own windows out of what Glimpse reads when the OS can't.
//
// With "Hide Glimpse from screenshots and screen sharing" off, Windows shows Glimpse's
// popups to every capture, Glimpse's own included (WDA_EXCLUDEFROMCAPTURE is all or
// nothing). So before a frame reaches OCR, the parts of it under a visible Glimpse popup
// are painted over with a flat colour: OCR finds no text there, and the rest of the frame
// is untouched. macOS doesn't need this: its capture filter skips Glimpse's windows by id.
import { intersection, type Rect } from "../geometry.ts";
import type { CaptureFrame } from "./port.ts";

/**
 * The frame with every rect (global logical) painted over, or the same frame when no rect
 * touches it. Never mutates `frame` (backends may reuse their buffers). The fill is the
 * colour just outside the masked area's top-left corner (black at the frame's edge), so a
 * popup over a light page becomes a light patch, not a hard dark box with edges to read.
 */
export function maskFrame(frame: CaptureFrame, rects: readonly Rect[]): CaptureFrame {
	const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
	for (const r of rects) {
		const hit = intersection(r, frame.rect);
		if (!hit) continue;
		const x0 = clamp(Math.floor((hit.x - frame.rect.x) * frame.scale), frame.width);
		const y0 = clamp(Math.floor((hit.y - frame.rect.y) * frame.scale), frame.height);
		const x1 = clamp(Math.ceil((hit.x + hit.width - frame.rect.x) * frame.scale), frame.width);
		const y1 = clamp(Math.ceil((hit.y + hit.height - frame.rect.y) * frame.scale), frame.height);
		if (x1 > x0 && y1 > y0) boxes.push({ x0, y0, x1, y1 });
	}
	if (boxes.length === 0) return frame;
	const data = new Uint8Array(frame.data);
	for (const b of boxes) {
		const fill = sample(frame, b.x0 - 1, b.y0 - 1);
		for (let y = b.y0; y < b.y1; y++) {
			for (let x = b.x0; x < b.x1; x++) data.set(fill, (y * frame.width + x) * 4);
		}
	}
	return { ...frame, data };
}

const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));

function sample(frame: CaptureFrame, x: number, y: number): Uint8Array {
	if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return new Uint8Array([0, 0, 0, 255]);
	const i = (y * frame.width + x) * 4;
	return frame.data.slice(i, i + 4);
}
