// Windows CaptureSource over glimpse.dll (app/native/windows/capture.cpp).
//
// Backends (spikes/capture/FINDINGS.md):
//   - Snip (one-shot): GDI. No session to warm up, nothing fragile.
//   - Live (session): DXGI Desktop Duplication per monitor, cheap once warm, no border.
//     Falls back to GDI per monitor when DXGI can't serve it (hybrid-GPU or remote
//     sessions, rotated outputs), and for a single frame when DXGI is temporarily out
//     (mode switch, secure desktop).
// Exclusion is a window flag: every Glimpse window gets WDA_EXCLUDEFROMCAPTURE
// (windows/capture-exclusion.ts) and the DWM leaves it out of GDI and DXGI alike.
//
// Coordinates: rects come in Electrobun's logical layout; glimpse.dll reports physical
// monitor rects keyed by HMONITOR (= Electrobun's Display.id). planCapture maps each
// piece with its own monitor's scale, and the DLL resamples mixed-DPI pieces.
import {
	type CaptureDisplay,
	CaptureError,
	type CaptureErrorCode,
	type CaptureFrame,
	type CaptureOptions,
	type CapturePlan,
	type CaptureSession,
	type CaptureSessionOptions,
	type CaptureSource,
	composeFrame,
	type Display,
	isCaptureError,
	planCapture,
	type Rect,
	withNativeBounds,
} from "@glimpse/core";
import type { WindowsBackend, WindowsCaptureBinding } from "../../native/windows.ts";
import { oneShotCounter, SequenceTracker } from "./sequence.ts";

/** DXGI failures that mean "this monitor won't work with DXGI in this session". */
export function dxgiFailureIsSticky(code: CaptureErrorCode): boolean {
	return code === "unavailable" || code === "failed" || code === "invalid-argument";
}

export interface WindowsCaptureDeps {
	readonly binding: WindowsCaptureBinding;
	/** Logical displays from the shell (Electrobun Screen). */
	readonly shellDisplays: () => readonly Display[];
	readonly now?: () => number;
	/** Called when a monitor falls back from DXGI to GDI, for diagnostics. */
	readonly onFallback?: (displayId: number, error: CaptureError) => void;
}

export class WindowsCaptureSource implements CaptureSource {
	readonly backend = "dxgi+gdi";
	readonly exclusion = "window-flag" as const;
	private readonly now: () => number;
	private readonly nextOneShot = oneShotCounter();
	private readonly sessions = new Set<WindowsSession>();

	constructor(private readonly deps: WindowsCaptureDeps) {
		this.now = deps.now ?? Date.now;
	}

	displays(): readonly Display[] {
		return this.deps.shellDisplays();
	}

	/** @internal Logical displays joined with glimpse.dll's physical rects. */
	captureDisplays(): CaptureDisplay[] {
		return withNativeBounds(this.deps.shellDisplays(), this.deps.binding.physicalDisplays());
	}

	/** @internal */
	plan(rect: Rect, options: CaptureOptions): CapturePlan {
		try {
			return planCapture(rect, this.captureDisplays(), { ...options, snapSource: true });
		} catch (e) {
			throw new CaptureError("invalid-argument", e instanceof Error ? e.message : String(e));
		}
	}

	async capture(rect: Rect, options: CaptureOptions = {}): Promise<CaptureFrame> {
		const plan = this.plan(rect, options);
		const capturedAt = this.now();
		return composeFrame(plan, (piece, out) => this.deps.binding.capturePiece("gdi", piece, out), {
			sequence: this.nextOneShot(),
			capturedAt,
		});
	}

	async openSession(rect: Rect, options: CaptureSessionOptions): Promise<CaptureSession> {
		if (!(options.fps > 0)) throw new CaptureError("invalid-argument", `fps must be positive, got ${options.fps}`);
		const session = new WindowsSession(this, this.deps, rect, options, this.now, () => {
			this.sessions.delete(session);
			// Last Live session gone: drop the DXGI duplications and their GPU devices.
			if (this.sessions.size === 0) this.deps.binding.release("dxgi");
		});
		this.sessions.add(session);
		try {
			await session.next(); // fail fast, and warm the duplication up
		} catch (e) {
			session.close();
			throw e;
		}
		return session;
	}

	setExcludedWindows(_windowIds: readonly number[]): void {
		// Nothing to do: WDA_EXCLUDEFROMCAPTURE on each window already hides it from GDI and DXGI.
	}

	dispose(): void {
		for (const s of [...this.sessions]) s.close();
		this.deps.binding.release("all");
	}
}

class WindowsSession implements CaptureSession {
	private plan: CapturePlan;
	private readonly gdiOnly = new Set<number>();
	private readonly tracker = new SequenceTracker();
	private closed = false;

	constructor(
		private readonly source: WindowsCaptureSource,
		private readonly deps: WindowsCaptureDeps,
		readonly rect: Rect,
		private readonly options: CaptureSessionOptions,
		private readonly now: () => number,
		private readonly onClose: () => void,
	) {
		this.plan = source.plan(rect, options);
	}

	async next(): Promise<CaptureFrame> {
		if (this.closed) throw new CaptureError("invalid-argument", "capture session is closed");
		try {
			return this.grab();
		} catch (e) {
			// A monitor was unplugged or re-arranged: re-plan once against fresh displays.
			if (!isCaptureError(e) || e.code !== "no-display") throw e;
			this.plan = this.source.plan(this.rect, this.options);
			this.tracker.invalidate();
			return this.grab();
		}
	}

	private grab(): CaptureFrame {
		const sequences: number[] = [];
		const capturedAt = this.now();
		const frame = composeFrame(
			this.plan,
			(piece, out) => {
				sequences.push(this.capturePiece(piece.displayId, (b) => this.deps.binding.capturePiece(b, piece, out)));
			},
			{ sequence: 0, capturedAt },
		);
		return { ...frame, sequence: this.tracker.update(sequences) };
	}

	/** DXGI first; GDI for this frame on a temporary failure, for the session on a lasting one. */
	private capturePiece(displayId: number, run: (backend: WindowsBackend) => number): number {
		if (!this.gdiOnly.has(displayId)) {
			try {
				return run("dxgi");
			} catch (e) {
				if (!isCaptureError(e) || e.code === "no-display") throw e;
				if (dxgiFailureIsSticky(e.code)) this.gdiOnly.add(displayId);
				this.deps.onFallback?.(displayId, e);
				this.tracker.invalidate();
			}
		}
		return run("gdi");
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.onClose();
	}
}
