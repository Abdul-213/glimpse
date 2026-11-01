// GLIM-59: the Live feature in the main process. A region from the picker (Live mode) becomes
// a pinned session: a persistent capture session (DXGI / SCStream / file backend), the core
// LiveRunner (GLIM-48 loop, GLIM-58 change detection and frame ring, the GLIM-102 pipeline
// session) and the native frame around the region (GLIM-90). It owns the `live.*` commands
// and the tray's Live state, and re-emits the typed `LiveSessionEvent`s for the docked popup
// (GLIM-79/81), which only has to render them.
//
// No electrobun import: tests drive it with ReplayCaptureSource, ManualTimers and a fake frame.
//
//   start(region)  stop any running session, open a capture session, pin the frame, run
//   stop()         stop capturing, remove the frame, drop the session caches (GLIM-20)
//   pause/resume   user pause (tray, popup), or automatic: screen lock / sleep reported by
//                  `systemEvent` (an unlock never resumes a session the user paused)
//   applySettings  Settings › Live (fps, diff threshold, stability) and target / source
//                  languages apply to the running session without restarting it
//
// Logs carry types, counts and timings only: never screen text (ARCHITECTURE.md logging).
import {
	type CaptureSource,
	type LivePauseReason,
	LiveRunner,
	type LiveRunnerStats,
	type LiveSessionEvent,
	type LiveSessionListener,
	type LiveStatus,
	type Logger,
	type OcrImage,
	type PipelineListener,
	type PipelineResult,
	type Rect,
	type Settings,
	systemTimers,
	type Timers,
} from "@glimpse/core";
import type { LiveState } from "../../tray-menu.ts";
import type { FrameTag } from "./frame-layout.ts";

/** What the service needs from a Live pipeline session (`TranslationService.openLive()`). */
export interface LivePipeline {
	process(image: OcrImage, options: { readonly onEvent: PipelineListener }): Promise<PipelineResult | null>;
	setSources(sources: Settings["language"]["sources"]): void;
	setTarget(target: Settings["language"]["target"]): void;
	close(): void;
}

/** The pinned frame (GLIM-90 `PinnedFrame`), as far as Live uses it. */
export interface LiveFrame {
	show(region: Rect): void;
	hide(): void;
	setPaused(paused: boolean): void;
	setTag(tag: FrameTag): void;
	setHighlight(box: Rect | null): void;
	dispose(): void;
}

export interface LiveServiceDeps {
	readonly capture: Pick<CaptureSource, "openSession">;
	readonly openPipeline: () => LivePipeline;
	readonly settings: () => Settings;
	/** Created per session; null when there is no frame (it is optional). */
	readonly frame: () => LiveFrame | null;
	readonly log: Logger;
	/** The tray mirrors this. */
	readonly onState?: (state: LiveState) => void;
	readonly timers?: Timers;
	readonly perfNow?: () => number;
	readonly newSessionId?: () => string;
}

export type SystemEvent = "lock" | "unlock" | "sleep" | "wake";

interface Running {
	readonly id: string;
	readonly region: Rect;
	readonly runner: LiveRunner;
	readonly pipeline: LivePipeline;
	readonly close: () => void;
	readonly frame: LiveFrame | null;
	readonly startedAt: number;
}

let sessionCounter = 0;

export class LiveService {
	readonly #d: LiveServiceDeps;
	readonly #listeners = new Set<LiveSessionListener>();
	#current: Running | null = null;
	#starting: Promise<void> | null = null;
	#popupVisible = false;
	#lastState: LiveState = "off";

	constructor(deps: LiveServiceDeps) {
		this.#d = deps;
	}

	/** A session is pinned (running or paused). */
	get active(): boolean {
		return this.#current !== null;
	}

	get status(): LiveStatus | "off" {
		return this.#current?.runner.status ?? "off";
	}

	get region(): Rect | null {
		return this.#current?.region ?? null;
	}

	/** The typed session events (GLIM-79/81 render them). Returns an unsubscribe. */
	onEvent(listener: LiveSessionListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Pin `region` (global logical) and start watching it. A running session is replaced (re-pin). */
	async start(region: Rect): Promise<void> {
		if (this.#starting) await this.#starting.catch(() => {});
		this.stop("repin");
		const run = this.#open(region);
		this.#starting = run;
		try {
			await run;
		} finally {
			if (this.#starting === run) this.#starting = null;
		}
	}

	async #open(region: Rect): Promise<void> {
		const settings = this.#d.settings();
		const timers = this.#d.timers ?? systemTimers;
		const id = this.#d.newSessionId?.() ?? `live-${Date.now().toString(36)}-${++sessionCounter}`;
		const log = this.#d.log;
		let capture: Awaited<ReturnType<CaptureSource["openSession"]>>;
		try {
			capture = await this.#d.capture.openSession(region, { fps: settings.live.fps });
		} catch (error) {
			log.warn("live: could not open a capture session", { error });
			const kind = (error as { code?: string }).code === "permission-denied" ? "screenAccess" : "captureFailed";
			this.#emit({
				type: "status",
				sessionId: id,
				status: "error",
				reason: null,
				error: { kind, message: error instanceof Error ? error.message : String(error) },
				stale: true,
				capturedAt: null,
				at: timers.now(),
			});
			return;
		}
		const pipeline = this.#d.openPipeline();
		const frame = this.#d.frame();
		const runner = new LiveRunner({
			sessionId: id,
			region,
			source: capture,
			timers,
			processor: pipeline,
			fps: settings.live.fps,
			diffThreshold: settings.live.diffThreshold,
			stabilityMs: settings.live.stabilityMs,
			...(this.#d.perfNow ? { perfNow: this.#d.perfNow } : {}),
			onEvent: (event) => this.#onRunnerEvent(event),
		});
		this.#current = {
			id,
			region,
			runner,
			pipeline,
			frame,
			startedAt: timers.now(),
			close: () => capture.close(),
		};
		frame?.setTag(this.#popupVisible ? { kind: "none" } : { kind: "live" });
		frame?.show(region);
		log.info("live: pinned", {
			session: id,
			rect: `${Math.round(region.x)},${Math.round(region.y)} ${Math.round(region.width)}x${Math.round(region.height)}`,
			fps: runner.stats().loop.fps,
			diffThreshold: settings.live.diffThreshold,
			stabilityMs: settings.live.stabilityMs,
			frame: frame !== null,
		});
		runner.start();
	}

	/** Stop and unpin. Drops the session's caches (GLIM-20). Idempotent. */
	stop(reason: "user" | "repin" | "quit" = "user"): void {
		const cur = this.#current;
		if (!cur) return;
		this.#current = null;
		const stats = cur.runner.stats();
		cur.runner.stop();
		cur.close();
		cur.pipeline.close();
		cur.frame?.dispose();
		this.#d.log.info("live: stopped", { session: cur.id, reason, ...summary(stats) });
		this.#setState("off");
	}

	pause(reason: LivePauseReason = "user"): void {
		this.#current?.runner.pause(reason);
	}

	/** Resume. With a reason (unlock, wake), only undoes a pause for that reason. */
	resume(reason?: LivePauseReason): void {
		this.#current?.runner.resume(reason);
	}

	/** OS lock / sleep notifications (live-popup.md L17: auto-pause, auto-resume). */
	systemEvent(event: SystemEvent): void {
		if (!this.#current) return;
		this.#d.log.info("live: system event", { event });
		if (event === "lock") this.pause("locked");
		else if (event === "unlock") this.resume("locked");
		else if (event === "sleep") this.pause("sleep");
		else this.resume("sleep");
	}

	/** The docked popup was shown or hidden (GLIM-79): the region tag shows only while it is hidden. */
	setPopupVisible(visible: boolean): void {
		this.#popupVisible = visible;
		this.#syncFrame();
	}

	/** A popup block is hovered (live-popup.md §2.4 linked block): its box, image px, or null. */
	highlightBlock(box: Rect | null, image: { readonly width: number; readonly height: number } | null): void {
		const cur = this.#current;
		if (!cur?.frame) return;
		if (!box || !image) {
			cur.frame.setHighlight(null);
			return;
		}
		const sx = cur.region.width / image.width;
		const sy = cur.region.height / image.height;
		cur.frame.setHighlight({
			x: cur.region.x + box.x * sx,
			y: cur.region.y + box.y * sy,
			width: box.width * sx,
			height: box.height * sy,
		});
	}

	/** Settings changed (AppSettings.subscribe). */
	applySettings(next: Settings, previous: Settings): void {
		const cur = this.#current;
		if (!cur) return;
		if (next.live !== previous.live) {
			cur.runner.setParams(next.live);
			this.#d.log.info("live: settings applied", { ...next.live });
		}
		const lang = next.language;
		const prev = previous.language;
		const languages = lang.target !== prev.target || lang.sources !== prev.sources;
		if (languages) {
			// TranslationService.applySettings updates its sessions too; both are idempotent.
			cur.pipeline.setTarget(lang.target);
			cur.pipeline.setSources(lang.sources);
		}
		if (languages || next.providers !== previous.providers) {
			// Results read for the old languages or engines no longer apply: re-read on the next grab.
			cur.runner.invalidate();
		}
	}

	stats(): (LiveRunnerStats & { readonly session: string }) | null {
		const cur = this.#current;
		return cur ? { ...cur.runner.stats(), session: cur.id } : null;
	}

	dispose(): void {
		this.stop("quit");
		this.#listeners.clear();
	}

	#onRunnerEvent(event: LiveSessionEvent): void {
		const cur = this.#current;
		if (!cur || event.sessionId !== cur.id) {
			// A stopping session's last status still goes out (the popup closes on it).
			if (event.type === "status" && event.status === "stopped") this.#emit(event);
			return;
		}
		if (event.type === "status") {
			this.#d.log.info("live: status", {
				session: event.sessionId,
				status: event.status,
				...(event.reason ? { reason: event.reason } : {}),
				...(event.error ? { error: event.error.kind, detail: event.error.message } : {}),
			});
			this.#syncFrame();
			this.#setState(event.status === "paused" || event.status === "error" ? "paused" : "running");
		} else if (event.type === "frame") {
			this.#d.log.debug("live: frame", {
				session: event.sessionId,
				frameSeq: event.frameSeq,
				upserts: event.upserts.length,
				removes: event.removes.length,
				changed: event.changeSet.length,
				blocks: event.order.length,
				reused: event.reused,
			});
		}
		this.#emit(event);
	}

	#syncFrame(): void {
		const cur = this.#current;
		if (!cur?.frame) return;
		const status = cur.runner.status;
		const paused = status === "paused" || status === "error";
		cur.frame.setPaused(paused);
		cur.frame.setTag(this.#popupVisible ? { kind: "none" } : paused ? { kind: "paused" } : { kind: "live" });
	}

	#setState(state: LiveState): void {
		if (state === this.#lastState) return;
		this.#lastState = state;
		this.#d.onState?.(state);
	}

	#emit(event: LiveSessionEvent): void {
		for (const l of this.#listeners) {
			try {
				l(event);
			} catch (error) {
				this.#d.log.warn("live: event listener failed", { error });
			}
		}
	}
}

function summary(s: LiveRunnerStats): Record<string, number | string> {
	return {
		grabs: s.grabs,
		newFrames: s.loop.newFrames,
		settled: s.decisions.settled,
		ocrRuns: s.ocrRuns,
		ringHits: s.ringHits,
		superseded: s.superseded,
		detectMsMean: Math.round(s.meanDetectMs * 100) / 100,
		detectMsMax: Math.round(s.maxDetectMs * 100) / 100,
		grabMsMean: Math.round(s.meanGrabMs * 100) / 100,
		settleToFrameMs: Math.round(s.meanSettleToFrameMs),
	};
}
