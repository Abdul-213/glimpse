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
//   consent        GLIM-79 (live-popup.md L10, core `liveCloudConsent`): when the session
//                  would send to a cloud provider, nothing is captured until the popup's
//                  question is answered (`answerConsent`: cloud, on-device, or cancel)
//
// Logs carry types, counts and timings only: never screen text (ARCHITECTURE.md logging).
import {
	type CaptureSource,
	type LivePauseReason,
	LiveRunner,
	type LiveRunnerStats,
	type LiveSessionEvent,
	type LiveSessionListener,
	type LiveSessionProviders,
	type LiveStatus,
	type Logger,
	liveCloudConsent,
	type OcrImage,
	type PipelineListener,
	type PipelineResult,
	type ProviderRef,
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
	/** GLIM-131 "Translate these": session-only source languages. Optional for older fakes. */
	includeSources?(langs: Settings["language"]["sources"]): void;
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
	/** `localOnly`: "Use on-device" was the consent answer (no cloud translators this session). */
	readonly openPipeline: (options: { readonly localOnly: boolean }) => LivePipeline;
	/** The OCR provider and first translator a session would use (consent and the popup's cloud row). */
	readonly providers?: () => { readonly ocr: ProviderRef | null; readonly translation: ProviderRef | null };
	/** "Don't ask again for Live" for this cloud translator (`settings.cloud.liveConsent`). */
	readonly rememberConsent?: (providerId: string) => void;
	/** App-wide Private, for the popup's first state. */
	readonly private?: () => boolean;
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

export type ConsentAnswer = "cloud" | "local" | "cancel";

interface PendingConsent {
	readonly id: string;
	readonly region: Rect;
	readonly frame: LiveFrame | null;
	readonly translation: ProviderRef | null;
}

interface Running {
	readonly id: string;
	readonly region: Rect;
	readonly runner: LiveRunner;
	readonly pipeline: LivePipeline;
	readonly close: () => void;
	readonly frame: LiveFrame | null;
	readonly startedAt: number;
	readonly providers: LiveSessionProviders;
}

let sessionCounter = 0;

export class LiveService {
	readonly #d: LiveServiceDeps;
	readonly #listeners = new Set<LiveSessionListener>();
	#current: Running | null = null;
	#pending: PendingConsent | null = null;
	#starting: Promise<void> | null = null;
	#popupVisible = false;
	#lastState: LiveState = "off";

	constructor(deps: LiveServiceDeps) {
		this.#d = deps;
	}

	/** A session is pinned (running, paused, or waiting for the cloud consent answer). */
	get active(): boolean {
		return this.#current !== null || this.#pending !== null;
	}

	get status(): LiveStatus | "off" | "consent" {
		if (this.#pending) return "consent";
		return this.#current?.runner.status ?? "off";
	}

	get region(): Rect | null {
		return this.#current?.region ?? this.#pending?.region ?? null;
	}

	get sessionId(): string | null {
		return this.#current?.id ?? this.#pending?.id ?? null;
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
		const timers = this.#d.timers ?? systemTimers;
		const id = this.#d.newSessionId?.() ?? `live-${timers.now().toString(36)}-${++sessionCounter}`;
		const refs = this.#d.providers?.() ?? { ocr: null, translation: null };
		const consent = liveCloudConsent({
			ocr: refs.ocr,
			translation: refs.translation,
			remembered: this.#d.settings().cloud.liveConsent,
		});
		if (consent.ask) {
			// L10: the popup asks first; the frame shows the region, nothing is captured yet.
			const frame = this.#d.frame();
			frame?.setPaused(true);
			frame?.setTag({ kind: "none" });
			frame?.show(region);
			this.#pending = { id, region, frame, translation: refs.translation };
			this.#emit({
				type: "opened",
				sessionId: id,
				region,
				providers: { cloud: consent.providers[0] ?? null, localOnly: false },
				private: this.#d.private?.() ?? false,
			});
			this.#emit({
				type: "consent",
				sessionId: id,
				providers: consent.providers,
				canRemember: consent.canRemember,
				reason: consent.reason,
			});
			this.#d.log.info("live: waiting for cloud consent", { session: id, reason: consent.reason });
			this.#setState("paused");
			return;
		}
		const cloud = [refs.ocr, refs.translation].find((p) => p?.kind === "cloud") ?? null;
		await this.#run(region, id, { cloud, localOnly: false }, null);
	}

	/**
	 * The popup's answer to the cloud question (L10). `cloud`: go ahead (and remember it for this
	 * translator when asked to); `local`: run on this device only; `cancel`: unpin.
	 */
	async answerConsent(sessionId: string, answer: ConsentAnswer, remember = false): Promise<void> {
		const p = this.#pending;
		if (!p || p.id !== sessionId) return;
		this.#pending = null;
		this.#d.log.info("live: cloud consent answered", { session: p.id, answer, remember });
		if (answer === "cancel") {
			p.frame?.dispose();
			this.#emitStopped(p.id);
			this.#setState("off");
			return;
		}
		if (answer === "cloud" && remember && p.translation?.kind === "cloud") this.#d.rememberConsent?.(p.translation.id);
		const refs = this.#d.providers?.() ?? { ocr: null, translation: null };
		const cloud = answer === "local" ? null : ([refs.ocr, refs.translation].find((x) => x?.kind === "cloud") ?? null);
		await this.#run(p.region, p.id, { cloud, localOnly: answer === "local" }, p.frame);
	}

	async #run(region: Rect, id: string, providers: LiveSessionProviders, frame: LiveFrame | null): Promise<void> {
		const run = this.#open(region, id, providers, frame);
		this.#starting = run;
		try {
			await run;
		} finally {
			if (this.#starting === run) this.#starting = null;
		}
	}

	async #open(region: Rect, id: string, providers: LiveSessionProviders, pinnedFrame: LiveFrame | null): Promise<void> {
		const settings = this.#d.settings();
		const timers = this.#d.timers ?? systemTimers;
		const log = this.#d.log;
		this.#emit({ type: "opened", sessionId: id, region, providers, private: this.#d.private?.() ?? false });
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
			pinnedFrame?.dispose();
			return;
		}
		const pipeline = this.#d.openPipeline({ localOnly: providers.localOnly });
		const frame = pinnedFrame ?? this.#d.frame();
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
			// GLIM-67: unchanged blocks reuse cached translations; the hit rate, at debug level.
			onCache: (c) =>
				log.debug("live: translation cache", {
					session: id,
					frameSeq: c.frameSeq,
					translated: c.translated,
					cached: c.cached,
					hitRate: c.translated === 0 ? 1 : Math.round((c.cached / c.translated) * 100) / 100,
					sessionHitRate: c.totalTranslated === 0 ? 1 : Math.round((c.totalCached / c.totalTranslated) * 100) / 100,
				}),
		});
		this.#current = {
			id,
			region,
			runner,
			pipeline,
			frame,
			startedAt: timers.now(),
			providers,
			close: () => capture.close(),
		};
		this.#syncFrame();
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
		const pending = this.#pending;
		if (pending) {
			this.#pending = null;
			pending.frame?.dispose();
			this.#d.log.info("live: stopped before consent", { session: pending.id, reason });
			this.#emitStopped(pending.id);
			this.#setState("off");
		}
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

	/**
	 * Re-read the region on the next grab, without the frame ring (GLIM-123): a language pack
	 * landed, so blocks that were waiting for it translate in place. The session keeps running.
	 */
	refresh(reason: "pack-installed"): void {
		const cur = this.#current;
		if (!cur) return;
		cur.runner.invalidate();
		this.#d.log.info("live: re-reading the region", { session: cur.id, reason });
	}

	/**
	 * GLIM-131 "Translate these" on the skipped line: translate these languages for the rest of
	 * this session (Settings unchanged) and re-read the region now, so the skipped blocks move
	 * into the list without a mark (live-popup.md §5 rule 7).
	 */
	includeLanguages(langs: Settings["language"]["sources"]): void {
		const cur = this.#current;
		if (!cur || langs.length === 0 || !cur.pipeline.includeSources) return;
		cur.pipeline.includeSources(langs);
		cur.runner.invalidate();
		this.#d.log.info("live: translating skipped languages for this session", {
			session: cur.id,
			langs: langs.join(","),
		});
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
		} else if (event.type === "packs") {
			this.#d.log.info("live: language packs missing", {
				session: event.sessionId,
				langs: event.rows.map((r) => r.lang).join(","),
				blocks: event.rows.reduce((n, r) => n + r.segmentIds.length, 0),
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
		// §2.4: the tag shows only while the popup is hidden; with cloud it names the company.
		const company = cur.providers.cloud?.name.split(" ")[0];
		cur.frame.setTag(
			this.#popupVisible
				? { kind: "none" }
				: paused
					? { kind: "paused" }
					: company
						? { kind: "cloud", company }
						: { kind: "live" },
		);
	}

	#emitStopped(sessionId: string): void {
		const timers = this.#d.timers ?? systemTimers;
		this.#emit({
			type: "status",
			sessionId,
			status: "stopped",
			reason: null,
			error: null,
			stale: true,
			capturedAt: null,
			at: timers.now(),
		});
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
		translatedBlocks: s.translatedBlocks,
		cachedBlocks: s.cachedBlocks,
		superseded: s.superseded,
		detectMsMean: Math.round(s.meanDetectMs * 100) / 100,
		detectMsMax: Math.round(s.maxDetectMs * 100) / 100,
		grabMsMean: Math.round(s.meanGrabMs * 100) / 100,
		settleToFrameMs: Math.round(s.meanSettleToFrameMs),
	};
}
