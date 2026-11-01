// A whole Live session, headless (GLIM-58): the core LiveRunner (capture loop -> change
// detection -> frame ring -> LivePipelineSession -> block diff) over any CaptureSource, with
// the pipeline built from the given providers. Reports every grab's decision, the Live
// session events, OCR counts and costs. Virtual time by default, so a 12 s recording replays
// in well under a second; `timers: systemTimers` for wall-clock runs (real OCR).
import {
	type BlockGrouper,
	type BlockLanguageDetector,
	type CaptureSource,
	type LanguageCode,
	LivePipelineSession,
	LiveRunner,
	type LiveRunnerStats,
	type LiveSessionEvent,
	type LiveTrace,
	type OcrProvider,
	type Rect,
	type Timers,
	TranslationCaches,
	TranslationPipeline,
	type TranslationProvider,
} from "@glimpse/core";
import { ManualTimers } from "@glimpse/core/testing";

export interface LiveSessionRunOptions {
	readonly ocr: OcrProvider;
	readonly translation: TranslationProvider | readonly TranslationProvider[];
	readonly to: LanguageCode;
	readonly sources?: readonly LanguageCode[];
	readonly private?: boolean;
	readonly detector?: BlockLanguageDetector;
	readonly grouper?: BlockGrouper;
	readonly fps: number;
	readonly diffThreshold: number;
	readonly stabilityMs: number;
	readonly durationMs: number;
	readonly scale?: number;
	/** Default: virtual time (`ManualTimers`). A timed file source must read the same clock. */
	readonly timers?: Timers;
	/** Process CPU time in µs (`process.cpuUsage()` user + system), for the cost line. */
	readonly cpuMicros?: () => number;
}

export interface LiveSessionReport {
	readonly mode: "live-session";
	readonly backend: string;
	readonly rect: Rect;
	readonly durationMs: number;
	readonly params: { readonly fps: number; readonly diffThreshold: number; readonly stabilityMs: number };
	/** One per grab; `t` is ms since the session started. */
	readonly traces: readonly (LiveTrace & { readonly t: number })[];
	/** Live session events with `t` (no screen text beyond what the scripted OCR returned). */
	readonly events: readonly (LiveSessionEvent & { readonly t: number })[];
	/** OCR calls the provider actually received. */
	readonly ocrCalls: number;
	readonly stats: LiveRunnerStats;
	/** Whole-process CPU over the run divided by grabs (includes the OCR/translation workers). */
	readonly cpuMsPerGrab: number | null;
	readonly wallMs: number;
}

export async function runLiveSession(
	source: CaptureSource,
	rect: Rect,
	options: LiveSessionRunOptions,
): Promise<LiveSessionReport> {
	const timers = options.timers ?? new ManualTimers();
	const chain: readonly TranslationProvider[] = Array.isArray(options.translation)
		? options.translation
		: [options.translation as TranslationProvider];
	const pipeline = new TranslationPipeline({
		ocr: () => options.ocr,
		chain: () => chain,
		clock: timers,
		...(options.detector ? { detector: options.detector } : {}),
		...(options.grouper ? { grouper: options.grouper } : {}),
	});
	const caches = new TranslationCaches({ now: timers.now });
	const session = new LivePipelineSession({
		pipeline,
		caches,
		target: options.to,
		sources: options.sources ?? [],
		private: options.private ?? false,
	});
	const capture = await source.openSession(rect, {
		fps: options.fps,
		...(options.scale === undefined ? {} : { scale: options.scale }),
	});
	const t0 = timers.now();
	const traces: (LiveTrace & { t: number })[] = [];
	const events: (LiveSessionEvent & { t: number })[] = [];
	let ocrCalls = 0;
	const counted = {
		process: (...args: Parameters<LivePipelineSession["process"]>) => {
			ocrCalls++;
			return session.process(...args);
		},
	};
	const runner = new LiveRunner({
		sessionId: "harness",
		region: rect,
		source: capture,
		timers,
		processor: counted,
		fps: options.fps,
		diffThreshold: options.diffThreshold,
		stabilityMs: options.stabilityMs,
		perfNow: () => performance.now(),
		onEvent: (e) => events.push({ ...e, t: timers.now() - t0 }),
		onTrace: (tr) => traces.push({ ...tr, t: tr.at - t0 }),
	});
	const cpu0 = options.cpuMicros?.() ?? null;
	const wall0 = performance.now();
	try {
		runner.start();
		if (timers instanceof ManualTimers) await timers.advance(options.durationMs);
		else await Bun.sleep(options.durationMs);
	} finally {
		runner.stop();
		session.close();
		capture.close();
	}
	const wallMs = performance.now() - wall0;
	const stats = runner.stats();
	const cpu1 = options.cpuMicros?.() ?? null;
	return {
		mode: "live-session",
		backend: source.backend,
		rect,
		durationMs: options.durationMs,
		params: { fps: stats.loop.fps, diffThreshold: options.diffThreshold, stabilityMs: options.stabilityMs },
		traces,
		events,
		ocrCalls,
		stats,
		cpuMsPerGrab: cpu0 !== null && cpu1 !== null ? (cpu1 - cpu0) / 1000 / Math.max(1, stats.grabs) : null,
		wallMs,
	};
}

/** The report as text lines (the CLI prints these; no screen text unless the OCR is scripted). */
export function liveSessionLines(r: LiveSessionReport, frameName?: (t: number) => string): string[] {
	const out: string[] = [];
	out.push(
		`live session ${r.backend} ${r.rect.x},${r.rect.y} ${r.rect.width}x${r.rect.height}: ${r.params.fps} fps, ` +
			`diff ≥ ${(r.params.diffThreshold * 100).toFixed(1)} %, stable ${r.params.stabilityMs} ms, ${r.durationMs} ms`,
	);
	for (const tr of r.traces) {
		const what = frameName ? ` ${frameName(tr.t).padEnd(6)}` : "";
		const pct = tr.fraction === undefined ? "" : ` ${(tr.fraction * 100).toFixed(2)} %`;
		const act = tr.action === "none" ? "" : `  -> ${tr.action.toUpperCase()}`;
		out.push(
			`  t=${String(Math.round(tr.t)).padStart(5)}${what} seq ${String(tr.sequence).padStart(2)} ` +
				`${tr.decision}${tr.reason ? `(${tr.reason})` : ""}${pct}${act}`,
		);
	}
	for (const e of r.events) {
		if (e.type === "status") out.push(`  [${Math.round(e.t)}] status ${e.status}${e.reason ? ` (${e.reason})` : ""}`);
		else if (e.type === "frame")
			out.push(
				`  [${Math.round(e.t)}] frame #${e.frameSeq}${e.reused ? " (frame ring)" : ""}: ` +
					`${e.upserts.length} upserted, ${e.removes.length} removed, change set [${e.changeSet.join(", ")}]` +
					e.upserts
						.map(
							(u) =>
								`\n      ${u.id} ${u.cls} ${JSON.stringify(u.source)}${u.translation ? ` → ${JSON.stringify(u.translation)}` : ""}`,
						)
						.join(""),
			);
		else if (e.final) out.push(`  [${Math.round(e.t)}] translation #${e.frameSeq} ${e.id} → ${JSON.stringify(e.text)}`);
	}
	const s = r.stats;
	out.push(
		`  ${s.grabs} grabs (${s.loop.newFrames} new): ${s.decisions.first} first, ${s.decisions.same} same, ` +
			`${s.decisions.settling} settling, ${s.decisions.settled} settled, ${s.decisions["below-threshold"]} below threshold`,
	);
	out.push(
		`  OCR runs ${s.ocrRuns} (provider calls ${r.ocrCalls}, superseded ${s.superseded}), frame-ring reuses ${s.ringHits}, blank ${s.blankFrames}`,
	);
	out.push(
		`  per grab: capture ${s.meanGrabMs.toFixed(2)} ms, change detection ${s.meanDetectMs.toFixed(3)} ms mean / ` +
			`${s.maxDetectMs.toFixed(2)} ms max; settle → frame event ${s.meanSettleToFrameMs.toFixed(1)} ms` +
			(r.cpuMsPerGrab === null ? "" : `; process CPU ${r.cpuMsPerGrab.toFixed(2)} ms/grab`),
	);
	return out;
}
