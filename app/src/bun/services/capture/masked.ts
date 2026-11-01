// GLIM-98: the capture source Snip and Live read from. It passes everything through to the
// backend and paints over the Glimpse windows the OS lets into the frame (`masks()`, global
// logical; see core `maskFrame`). With "Hide Glimpse from screenshots and screen sharing" on,
// or on macOS, `masks()` is empty and frames go through untouched.
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
		return this.mask(await this.inner.capture(rect, options));
	}

	async openSession(rect: Rect, options: CaptureSessionOptions): Promise<CaptureSession> {
		const session = await this.inner.openSession(rect, options);
		return {
			rect: session.rect,
			next: async () => this.mask(await session.next()),
			close: () => session.close(),
		};
	}

	setExcludedWindows(windowIds: readonly number[]): void {
		this.inner.setExcludedWindows(windowIds);
	}

	dispose(): void {
		this.inner.dispose();
	}

	private mask(frame: CaptureFrame): CaptureFrame {
		const rects = this.masks();
		return rects.length === 0 ? frame : maskFrame(frame, rects);
	}
}
