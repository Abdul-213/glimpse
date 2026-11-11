// macOS loupe sampler (GLIM-91): one ScreenCaptureKit stream over the display under the
// pointer at 30 fps, read 15 x 15 px at a time with glim_capture_stream_sample. A
// screenshot per sample (SCScreenshotManager) is too slow for the spec's 30 Hz; a warm
// stream makes each sample a 900-byte copy out of the newest IOSurface.
//
// The stream follows the pointer: moving to another display closes it and opens one
// there. Opening runs on the helper's queue (GLIM-97, typically 100-300 ms, unmeasured):
// samples asked for meanwhile wait for the same open. If the stream can't start, sampling
// falls back to one-shot captures (`fallback`).
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
	private opening: { readonly displayId: number; readonly promise: Promise<OpenStream | null> } | null = null;
	/** Bumped by stop() and display changes: an open that finishes for an older one is closed. */
	private generation = 0;
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
		const stream = await this.streamFor(display);
		if (!stream) return this.fallback.sample(centre, size);
		if (this.stream !== stream) return null; // moved on (another display, stop) while it opened
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

	private streamFor(display: Display): Promise<OpenStream | null> {
		if (this.stream?.displayId === display.id) return Promise.resolve(this.stream);
		if (this.opening?.displayId === display.id) return this.opening.promise;
		this.closeStream();
		const generation = ++this.generation;
		const scale = display.scaleFactor > 0 ? display.scaleFactor : 1;
		const width = Math.round(display.bounds.width * scale);
		const height = Math.round(display.bounds.height * scale);
		const promise = this.binding
			.streamOpen(
				display.id,
				{ x: 0, y: 0, width: display.bounds.width, height: display.bounds.height },
				width,
				height,
				LOUPE_STREAM_FPS,
			)
			.then(
				(handle): OpenStream | null => {
					const stream = { displayId: display.id, handle, scale: width / display.bounds.width };
					if (generation !== this.generation) {
						// Stopped or moved to another display meanwhile: nobody wants it.
						this.binding.streamClose(handle);
						return null;
					}
					this.stream = stream;
					return stream;
				},
				(error: unknown) => {
					if (generation === this.generation) {
						this.onError(error);
						this.failedDisplays.add(display.id);
					}
					return null;
				},
			)
			.finally(() => {
				if (this.opening?.promise === promise) this.opening = null;
			});
		this.opening = { displayId: display.id, promise };
		return promise;
	}

	private closeStream(): void {
		this.generation++;
		this.opening = null;
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
