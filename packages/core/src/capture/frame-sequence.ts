// A CaptureSource over in-memory desktop images. It backs the file-based capture
// backend (app/src/bun/services/capture/file.ts, Linux dev + CI, GLIM-86) and the
// ReplayCaptureSource fake in @glimpse/core/testing.
//
// Each frame is an image of the whole (virtual) desktop. `displays[].nativeBounds`
// says which pixels of the image belong to which display; `bounds` and
// `scaleFactor` are the logical layout a real shell would report.
import type { Rect } from "../geometry.ts";
import type { Display } from "../region.ts";
import { composeFrame } from "./compose.ts";
import { blitRgba, type RgbaImage } from "./pixels.ts";
import { type CaptureDisplay, planCapture } from "./plan.ts";
import {
	CaptureError,
	type CaptureFrame,
	type CaptureOptions,
	type CaptureSession,
	type CaptureSessionOptions,
	type CaptureSource,
} from "./port.ts";

export interface SequenceFrame {
	readonly image: RgbaImage;
	/** How long this frame stays on screen in `timed` mode. Default 250 ms. */
	readonly holdMs?: number;
	/** Label for diagnostics (usually the file name). */
	readonly name?: string;
}

/**
 * - `per-grab`: every `capture()` / `session.next()` shows the next frame. Deterministic,
 *   the default for tests: N grabs walk N frames.
 * - `timed`: the frame on screen is picked from the time elapsed since the source was
 *   created (one-shots) or the session was opened, using `holdMs`. For harness runs that
 *   exercise real Live-mode timing.
 */
export type SequenceAdvance = "per-grab" | "timed";

export interface FrameSequenceOptions {
	readonly displays: readonly CaptureDisplay[];
	readonly frames: readonly SequenceFrame[];
	readonly advance?: SequenceAdvance;
	/** After the last frame: `hold` it (default) or `loop` back to the first. */
	readonly end?: "hold" | "loop";
	/** Epoch ms. Inject a manual clock in tests. */
	readonly now: () => number;
	readonly backend?: string;
}

const DEFAULT_HOLD_MS = 250;

export class FrameSequenceSource implements CaptureSource {
	readonly backend: string;
	readonly exclusion = "none" as const;
	/** Last ids passed to setExcludedWindows (tests assert on it). */
	excludedWindows: readonly number[] = [];
	private readonly opts: FrameSequenceOptions;
	private readonly createdAt: number;
	private oneShotCursor = 0;
	private readonly sessions = new Set<SequenceSession>();
	private disposed = false;
	/** changed[j]: frame j differs from the one before it (j = 0: from the last frame, for loops). */
	private readonly changed: readonly boolean[];
	private readonly changesPerLoop: number;

	constructor(options: FrameSequenceOptions) {
		if (options.frames.length === 0) throw new RangeError("a frame sequence needs at least one frame");
		if (options.displays.length === 0) throw new RangeError("a frame sequence needs at least one display");
		this.opts = options;
		this.backend = options.backend ?? "frames";
		this.createdAt = options.now();
		const frames = options.frames;
		const n = frames.length;
		this.changed = frames.map((f, j) => !sameImage(f.image, frames[(j + n - 1) % n]?.image));
		this.changesPerLoop = this.changed.filter(Boolean).length;
	}

	get frameCount(): number {
		return this.opts.frames.length;
	}

	/** One pass through the recording in `timed` mode (sum of `holdMs`), ms. */
	get durationMs(): number {
		return this.opts.frames.reduce((s, f) => s + (f.holdMs ?? DEFAULT_HOLD_MS), 0);
	}

	displays(): readonly Display[] {
		return this.opts.displays.map(({ nativeBounds: _n, ...d }) => d);
	}

	async capture(rect: Rect, options: CaptureOptions = {}): Promise<CaptureFrame> {
		this.assertOpen();
		const step = this.opts.advance === "timed" ? this.timedStep(this.createdAt) : this.oneShotCursor++;
		return this.render(rect, options, step);
	}

	async openSession(rect: Rect, options: CaptureSessionOptions): Promise<CaptureSession> {
		this.assertOpen();
		if (!(options.fps > 0)) throw new CaptureError("invalid-argument", `fps must be positive, got ${options.fps}`);
		// Validate the rect now, like native backends do when they start a stream.
		this.render(rect, options, 0);
		const session = new SequenceSession(this, rect, options, this.opts.now(), () => this.sessions.delete(session));
		this.sessions.add(session);
		return session;
	}

	setExcludedWindows(windowIds: readonly number[]): void {
		this.excludedWindows = [...windowIds];
	}

	dispose(): void {
		for (const s of [...this.sessions]) s.close();
		this.disposed = true;
	}

	/**
	 * @internal Frame index and sequence for a monotonically increasing step. The
	 * sequence only moves when the image differs from the previous step's, so holding
	 * the last frame or repeating an identical frame reads as "nothing changed", exactly
	 * like an idle DXGI duplication or SCStream.
	 */
	resolve(step: number): { index: number; sequence: number } {
		const n = this.opts.frames.length;
		const loop = this.opts.end === "loop";
		const s = loop ? step : Math.min(step, n - 1);
		const index = s % n;
		let changes = loop ? Math.floor(s / n) * this.changesPerLoop : 0;
		for (let j = 1; j <= index; j++) if (this.changed[j]) changes++;
		return { index, sequence: 1 + changes };
	}

	/** @internal */
	timedStep(since: number): number {
		const elapsed = Math.max(0, this.opts.now() - since);
		const frames = this.opts.frames;
		const total = frames.reduce((s, f) => s + (f.holdMs ?? DEFAULT_HOLD_MS), 0);
		const loops = total > 0 ? Math.floor(elapsed / total) : 0;
		let t = total > 0 ? elapsed - loops * total : 0;
		if (this.opts.end !== "loop" && loops > 0) return frames.length - 1;
		for (let i = 0; i < frames.length; i++) {
			t -= frames[i]?.holdMs ?? DEFAULT_HOLD_MS;
			if (t < 0) return loops * frames.length + i;
		}
		return loops * frames.length + frames.length - 1;
	}

	/** @internal */
	render(rect: Rect, options: CaptureOptions, step: number): CaptureFrame {
		this.assertOpen();
		const { index, sequence } = this.resolve(step);
		const frame = this.opts.frames[index];
		if (!frame) throw new CaptureError("failed", `no frame ${index}`);
		let plan: ReturnType<typeof planCapture>;
		try {
			plan = planCapture(rect, this.opts.displays, { ...options, snapSource: true });
		} catch (e) {
			throw new CaptureError("invalid-argument", e instanceof Error ? e.message : String(e));
		}
		return composeFrame(plan, (piece, out) => blitRgba(frame.image, piece.source, out, piece.dest), {
			sequence,
			capturedAt: this.opts.now(),
		});
	}

	/** @internal */
	get advanceMode(): SequenceAdvance {
		return this.opts.advance ?? "per-grab";
	}

	private assertOpen(): void {
		if (this.disposed) throw new CaptureError("unavailable", "capture source was disposed");
	}
}

class SequenceSession implements CaptureSession {
	private step = 0;
	private closed = false;

	constructor(
		private readonly source: FrameSequenceSource,
		readonly rect: Rect,
		private readonly options: CaptureSessionOptions,
		private readonly openedAt: number,
		private readonly onClose: () => void,
	) {}

	async next(): Promise<CaptureFrame> {
		if (this.closed) throw new CaptureError("invalid-argument", "capture session is closed");
		const step = this.source.advanceMode === "timed" ? this.source.timedStep(this.openedAt) : this.step++;
		return this.source.render(this.rect, this.options, step);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.onClose();
	}
}

function sameImage(a: RgbaImage, b: RgbaImage | undefined): boolean {
	if (!b || a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) return false;
	if (a === b) return true;
	const x = a.data;
	const y = b.data;
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
}
