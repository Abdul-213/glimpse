// macOS loupe sampler (GLIM-91): one ScreenCaptureKit stream over the display under the
// pointer at 30 fps, read 15 x 15 px at a time with glim_capture_stream_sample. A
// screenshot per sample (SCScreenshotManager) is too slow for the spec's 30 Hz; a warm
// stream makes each sample a 900-byte copy out of the newest IOSurface.
//
// The stream follows the pointer: moving to another display closes it and opens one
// there. Opening blocks the Bun worker until SCK starts (typically 100-300 ms, unmeasured),
// so the window controller asks for the first sample only after the overlays are shown.
// If the stream can't start, sampling falls back to one-shot captures (`fallback`).
import { type Display, devicePixelAt, displayAt, type LoupePatch, type PixelSampler, type Point } from "@glimpse/core";
import type { MacCaptureBinding, MacPickerBinding, StreamHandle } from "../../native/macos.ts";

export const LOUPE_STREAM_FPS = 30;

interface OpenStream {
	readonly displayId: number;
	readonly handle: StreamHandle;
	/** Stream px per logical unit. */
	readonly scale: number;
}

export class MacStreamPixelSampler implements PixelSampler {
	private stream: OpenStream | null = null;
	private failedDisplays = new Set<number>();

	constructor(
		private readonly binding: MacCaptureBinding & MacPickerBinding,
		private readonly displays: () => readonly Display[],
		private readonly fallback: PixelSampler,
		private readonly onError: (error: unknown) => void = () => {},
	) {}

	async sample(centre: Point, size: number): Promise<LoupePatch | null> {
		const display = displayAt(this.displays(), centre);
		if (!display) return null;
		if (this.failedDisplays.has(display.id)) return this.fallback.sample(centre, size);
		const stream = this.streamFor(display);
		if (!stream) return this.fallback.sample(centre, size);
		const px = devicePixelAt({ ...display, scaleFactor: stream.scale }, centre);
		const half = Math.floor(size / 2);
		const rgba = new Uint8Array(size * size * 4);
		try {
			const sequence = this.binding.streamSample(stream.handle, px.x - half, px.y - half, size, rgba);
			if (sequence === null) return null; // first frame not there yet: empty grid
			return { centre, displayId: display.id, size, rgba, sequence };
		} catch (error) {
			this.onError(error);
			this.closeStream();
			this.failedDisplays.add(display.id);
			return this.fallback.sample(centre, size);
		}
	}

	private streamFor(display: Display): OpenStream | null {
		if (this.stream?.displayId === display.id) return this.stream;
		this.closeStream();
		const scale = display.scaleFactor > 0 ? display.scaleFactor : 1;
		const width = Math.round(display.bounds.width * scale);
		const height = Math.round(display.bounds.height * scale);
		try {
			const handle = this.binding.streamOpen(
				display.id,
				{ x: 0, y: 0, width: display.bounds.width, height: display.bounds.height },
				width,
				height,
				LOUPE_STREAM_FPS,
			);
			this.stream = { displayId: display.id, handle, scale: width / display.bounds.width };
			return this.stream;
		} catch (error) {
			this.onError(error);
			this.failedDisplays.add(display.id);
			return null;
		}
	}

	private closeStream(): void {
		if (!this.stream) return;
		try {
			this.binding.streamClose(this.stream.handle);
		} catch {
			// already gone
		}
		this.stream = null;
	}

	stop(): void {
		this.closeStream();
		this.failedDisplays = new Set();
		this.fallback.stop();
	}
}
