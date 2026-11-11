import type { Rect } from "../geometry.ts";
import type { OcrImage } from "../providers/ocr.ts";
import { allocRgba, fillOpaqueBlack, type RgbaImage } from "./pixels.ts";
import type { CapturePiece, CapturePlan } from "./plan.ts";
import { CaptureError, type CaptureFrame } from "./port.ts";

/**
 * Run a plan: allocate the output, black-fill it when part of the rect is off-screen,
 * and let `drawPiece` write each piece into `dest` of the output. Backends differ only
 * in `drawPiece` (a native call per piece, or a blit from a frame image).
 */
export function composeFrame(
	plan: CapturePlan,
	drawPiece: (piece: CapturePiece, out: RgbaImage) => void,
	meta: { readonly sequence: number; readonly capturedAt: number },
): CaptureFrame {
	if (plan.pieces.length === 0) {
		throw new CaptureError("no-display", `rect ${formatRect(plan.rect)} is not on any display`);
	}
	const out = allocRgba(plan.width, plan.height);
	if (plan.partial) fillOpaqueBlack(out);
	for (const piece of plan.pieces) drawPiece(piece, out);
	return frameOf(plan, out, meta);
}

/**
 * `composeFrame` for backends whose pieces arrive asynchronously (macOS ScreenCaptureKit
 * off the Bun worker, GLIM-97). Pieces are drawn concurrently into disjoint parts of the
 * output; the first failure rejects once every piece has settled, so no write lands after.
 */
export async function composeFrameAsync(
	plan: CapturePlan,
	drawPiece: (piece: CapturePiece, out: RgbaImage) => Promise<void>,
	meta: { readonly sequence: number; readonly capturedAt: number },
): Promise<CaptureFrame> {
	if (plan.pieces.length === 0) {
		throw new CaptureError("no-display", `rect ${formatRect(plan.rect)} is not on any display`);
	}
	const out = allocRgba(plan.width, plan.height);
	if (plan.partial) fillOpaqueBlack(out);
	const results = await Promise.allSettled(plan.pieces.map((piece) => drawPiece(piece, out)));
	const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
	if (failed) throw failed.reason;
	return frameOf(plan, out, meta);
}

function frameOf(
	plan: CapturePlan,
	out: RgbaImage,
	meta: { readonly sequence: number; readonly capturedAt: number },
): CaptureFrame {
	return {
		width: out.width,
		height: out.height,
		data: out.data,
		rect: plan.rect,
		scale: plan.scale,
		displayIds: plan.pieces.map((p) => p.displayId),
		partial: plan.partial,
		sequence: meta.sequence,
		capturedAt: meta.capturedAt,
	};
}

/** A captured frame as OCR input (`OcrProvider.recognize`): RGBA8, tightly packed. */
export const toOcrImage = (frame: CaptureFrame): OcrImage => ({
	width: frame.width,
	height: frame.height,
	stride: frame.width * 4,
	format: "rgba8",
	data: frame.data,
});

export const formatRect = (r: Rect): string => `${r.x},${r.y} ${r.width}x${r.height}`;

/** Parse "x,y,w,h" (commas and/or spaces). Width and height must be positive. */
export function parseRect(text: string): Rect {
	const parts = text
		.trim()
		.split(/[\s,]+/)
		.filter((p) => p.length > 0)
		.map(Number);
	const [x, y, width, height] = parts;
	if (
		parts.length !== 4 ||
		x === undefined ||
		y === undefined ||
		width === undefined ||
		height === undefined ||
		!parts.every(Number.isFinite)
	) {
		throw new RangeError(`expected "x,y,width,height", got "${text}"`);
	}
	if (width <= 0 || height <= 0) throw new RangeError(`width and height must be positive, got ${width}x${height}`);
	return { x, y, width, height };
}
