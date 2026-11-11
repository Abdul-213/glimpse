// GLIM-98: the capture source Snip and Live read from. It passes everything through to the
// backend and paints over the Glimpse windows the OS lets into the frame (`masks()`, global
// logical; see core `maskFrame`). With "Show Glimpse in screen sharing and recordings" off
// (GLIM-164), or on macOS, `masks()` is empty and frames go through untouched.
//
// GLIM-164: the rects are read both before and after the backend captures, and both sets are
// painted over. A popup dragged across the region while a frame is grabbed is then covered
// where it was when the capture started and where it is when it returned, so a moved popup
// never leaks into a frame between two positions.
import {
	type CaptureFrame,
	type CaptureOptions,
	type CaptureSession,
	type CaptureSessionOptions,
	type CaptureSource,
	type Display,
	maskFrame,
	type Rect,
} from "@glimpse/core";

export class MaskedCaptureSource implements CaptureSource {
	constructor(
		private readonly inner: CaptureSource,
		private readonly masks: () => readonly Rect[],
	) {}

	get backend(): string {
		return this.inner.backend;
	}

	get exclusion() {
		return this.inner.exclusion;
	}

	displays(): readonly Display[] {
		return this.inner.displays();
	}

	async capture(rect: Rect, options?: CaptureOptions): Promise<CaptureFrame> {
		const before = this.masks();
		return this.mask(await this.inner.capture(rect, options), before);
	}

	async openSession(rect: Rect, options: CaptureSessionOptions): Promise<CaptureSession> {
		const session = await this.inner.openSession(rect, options);
		return {
			rect: session.rect,
			next: async () => {
				const before = this.masks();
				return this.mask(await session.next(), before);
			},
			close: () => session.close(),
		};
	}

	setExcludedWindows(windowIds: readonly number[]): void {
		this.inner.setExcludedWindows(windowIds);
	}

	dispose(): void {
		this.inner.dispose();
	}

	private mask(frame: CaptureFrame, before: readonly Rect[]): CaptureFrame {
		const rects = unionRects(before, this.masks());
		return rects.length === 0 ? frame : maskFrame(frame, rects);
	}
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Both lists, without repeating a rect that didn't move. Pure. */
export function unionRects(a: readonly Rect[], b: readonly Rect[]): Rect[] {
	const out = [...a];
	for (const r of b) if (!out.some((o) => sameRect(o, r))) out.push(r);
	return out;
}
