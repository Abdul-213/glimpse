// macOS CaptureSource over libglimpse.dylib (app/native/macos/capture.m), ScreenCaptureKit
// at native Retina resolution.
//   - Snip (one-shot): SCScreenshotManager per display piece.
//   - Live (session): one SCStream per display piece; reading is a copy of the newest
//     complete frame, and idle frames keep the sequence still.
// Exclusion is a filter: every SCContentFilter leaves out Glimpse's own app (or, if SCK
// doesn't list it, each of its windows). `setExcludedWindows` keeps the window list
// current and updates running streams. NSWindow.sharingType is set to none too
// (windows/capture-exclusion.ts) but isn't relied on: SCK ignores it on macOS 15+.
//
// Coordinates: Electrobun's logical space on macOS is global points, which is also what
// ScreenCaptureKit takes (display-local), so native bounds = logical bounds.
import {
	CaptureError,
	type CaptureFrame,
	type CaptureOptions,
	type CapturePlan,
	type CaptureSession,
	type CaptureSessionOptions,
	type CaptureSource,
	composeFrame,
	type Display,
	planCapture,
	type Rect,
	withLogicalNativeBounds,
} from "@glimpse/core";
import type { MacCaptureBinding, StreamHandle } from "../../native/macos.ts";
import { oneShotCounter, SequenceTracker } from "./sequence.ts";

export interface MacCaptureDeps {
	readonly binding: MacCaptureBinding;
	readonly shellDisplays: () => readonly Display[];
	readonly now?: () => number;
	/** Called when updating the exclusion list failed (diagnostics). */
	readonly onExclusionError?: (error: unknown) => void;
}

export class MacCaptureSource implements CaptureSource {
	readonly backend = "screencapturekit";
	readonly exclusion = "filter" as const;
	private readonly now: () => number;
	private readonly nextOneShot = oneShotCounter();
	private readonly sessions = new Set<MacSession>();

	constructor(private readonly deps: MacCaptureDeps) {
		this.now = deps.now ?? Date.now;
	}

	displays(): readonly Display[] {
		return this.deps.shellDisplays();
	}

	/** @internal */
	plan(rect: Rect, options: CaptureOptions): CapturePlan {
		try {
			return planCapture(rect, withLogicalNativeBounds(this.deps.shellDisplays()), options);
		} catch (e) {
			throw new CaptureError("invalid-argument", e instanceof Error ? e.message : String(e));
		}
	}

	async capture(rect: Rect, options: CaptureOptions = {}): Promise<CaptureFrame> {
		const plan = this.plan(rect, options);
		const capturedAt = this.now();
		return composeFrame(
			plan,
			(piece, out) => this.deps.binding.shot(piece.displayId, piece.sourceLocal, piece.dest, out),
			{ sequence: this.nextOneShot(), capturedAt },
		);
	}

	async openSession(rect: Rect, options: CaptureSessionOptions): Promise<CaptureSession> {
		if (!(options.fps > 0)) throw new CaptureError("invalid-argument", `fps must be positive, got ${options.fps}`);
		const plan = this.plan(rect, options);
		if (plan.pieces.length === 0) {
			throw new CaptureError("no-display", "the rect is not on any display");
		}
		const handles: StreamHandle[] = [];
		try {
			for (const piece of plan.pieces) {
				handles.push(
					this.deps.binding.streamOpen(
						piece.displayId,
						piece.sourceLocal,
						piece.dest.width,
						piece.dest.height,
						options.fps,
					),
				);
			}
		} catch (e) {
			for (const h of handles) this.deps.binding.streamClose(h);
			throw e;
		}
		const session = new MacSession(this.deps.binding, rect, plan, handles, this.now, () =>
			this.sessions.delete(session),
		);
		this.sessions.add(session);
		return session;
	}

	setExcludedWindows(windowIds: readonly number[]): void {
		try {
			this.deps.binding.setExcludedWindows(windowIds);
		} catch (e) {
			// Not fatal: the app-level exclusion in the filter usually covers new windows anyway.
			this.deps.onExclusionError?.(e);
		}
	}

	dispose(): void {
		for (const s of [...this.sessions]) s.close();
		this.deps.binding.reset();
	}
}

class MacSession implements CaptureSession {
	private readonly tracker = new SequenceTracker();
	private closed = false;

	constructor(
		private readonly binding: MacCaptureBinding,
		readonly rect: Rect,
		private readonly plan: CapturePlan,
		private readonly handles: readonly StreamHandle[],
		private readonly now: () => number,
		private readonly onClose: () => void,
	) {}

	async next(): Promise<CaptureFrame> {
		if (this.closed) throw new CaptureError("invalid-argument", "capture session is closed");
		const sequences: number[] = [];
		const capturedAt = this.now();
		let i = 0;
		const frame = composeFrame(
			this.plan,
			(piece, out) => {
				const handle = this.handles[i++];
				if (handle === undefined) throw new CaptureError("failed", "stream handle missing for a piece");
				sequences.push(this.binding.streamRead(handle, piece.dest, out));
			},
			{ sequence: 0, capturedAt },
		);
		return { ...frame, sequence: this.tracker.update(sequences) };
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const h of this.handles) this.binding.streamClose(h);
		this.onClose();
	}
}
