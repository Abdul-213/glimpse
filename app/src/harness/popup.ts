// Headless Snip popup (GLIM-65): the real SnipPopupController over a recording window, so
// tests and the harness run region → capture → pipeline → popup state without Electrobun
// or a webview. `FakePopupWindow` plays the view's part: it reports `painted` when asked.
import type {
	CaptureSource,
	Display,
	LanguageCode,
	Logger,
	Rect,
	SnipPopupPlacement,
	SnipPopupState,
	TranslationPipeline,
} from "@glimpse/core";
import { nullLogger, snipStatus, TranslationCache } from "@glimpse/core";
import type { Scheduler } from "../bun/windows/picker-controller.ts";
import {
	type PackPort,
	type PopupWindowPort,
	SnipPopupController,
	type SnipPopupSettings,
	type SnipRunner,
} from "../bun/windows/popup-controller.ts";
import type { SnipStateMessage } from "../shared/popup-rpc.ts";
import { ManualScheduler } from "./overlays.ts";

export class FakePopupWindow implements PopupWindowPort {
	visible = false;
	shows = 0;
	frames: Rect[] = [];
	messages: SnipStateMessage[] = [];

	setFrame(frame: Rect): void {
		this.frames.push(frame);
	}
	show(): void {
		this.visible = true;
		this.shows++;
	}
	hide(): void {
		this.visible = false;
	}
	send(message: SnipStateMessage): void {
		this.messages.push(message);
	}
	get last(): SnipStateMessage | undefined {
		return this.messages.at(-1);
	}
	get frame(): Rect | undefined {
		return this.frames.at(-1);
	}
}

export const DEFAULT_POPUP_SETTINGS: SnipPopupSettings = {
	reducedMotion: true,
	alwaysShowLanguages: false,
	showOriginalUnder: false,
	autoCopy: true,
	uiDir: "ltr",
};

export interface PopupHarness {
	readonly controller: SnipPopupController;
	readonly window: FakePopupWindow;
	readonly scheduler: ManualScheduler;
	readonly focusRestores: () => number;
	readonly resultsDismissed: () => number;
	/** Every clipboard write, in order. */
	readonly clipboard: string[];
	/** Every action target call: `snipAgain`, `settings:providers`, `url:...`. */
	readonly targets: string[];
}

export interface PopupHarnessOptions {
	readonly displays: () => readonly Display[];
	readonly runner: SnipRunner;
	readonly settings?: Partial<SnipPopupSettings>;
	readonly scheduler?: Scheduler & ManualScheduler;
	readonly log?: Logger;
	readonly packs?: PackPort;
	readonly eol?: "\n" | "\r\n";
	readonly providerShortName?: (id: string) => string | null;
}

export function popupHarness(o: PopupHarnessOptions): PopupHarness {
	const window = new FakePopupWindow();
	const scheduler = o.scheduler ?? new ManualScheduler();
	let restores = 0;
	let dismissed = 0;
	const clipboard: string[] = [];
	const targets: string[] = [];
	const controller = new SnipPopupController({
		window,
		displays: o.displays,
		runner: o.runner,
		focus: {
			save: () => {},
			restore: () => {
				restores++;
				return true;
			},
		},
		results: { dismiss: () => dismissed++ },
		clipboard: { writeText: (text) => clipboard.push(text) },
		...(o.eol ? { eol: o.eol } : {}),
		...(o.packs ? { packs: o.packs } : {}),
		...(o.providerShortName ? { providerShortName: o.providerShortName } : {}),
		targets: {
			snipAgain: () => targets.push("snipAgain"),
			openSettings: (section) => targets.push(`settings:${section}`),
			openExternal: (url) => targets.push(`url:${url}`),
		},
		settings: () => ({ ...DEFAULT_POPUP_SETTINGS, ...o.settings }),
		scheduler,
		log: o.log ?? nullLogger,
		newId: (() => {
			let n = 0;
			return () => `snip-${++n}`;
		})(),
	});
	return {
		controller,
		window,
		scheduler,
		focusRestores: () => restores,
		resultsDismissed: () => dismissed,
		clipboard,
		targets,
	};
}

/** A SnipRunner over a capture source and a core pipeline (what TranslationService.snip does). */
export function pipelineRunner(
	capture: Pick<CaptureSource, "capture">,
	pipeline: TranslationPipeline,
	opts: { to: LanguageCode; sources?: readonly LanguageCode[]; private?: boolean; cache?: TranslationCache },
): SnipRunner {
	const cache = opts.cache ?? new TranslationCache({ name: "harness-popup" });
	return {
		snip: (rect, onEvent, signal, runId) =>
			pipeline.snip(capture, rect, {
				runId,
				target: opts.to,
				sources: opts.sources ?? [],
				cache,
				private: opts.private ?? false,
				onEvent,
				signal,
			}),
		translate: (blocks, onEvent, signal, runId, extra) =>
			pipeline.translate(blocks, {
				runId,
				target: opts.to,
				sources: opts.sources ?? [],
				cache,
				private: opts.private ?? false,
				onEvent,
				signal,
				...extra,
			}),
	};
}

export interface SnipPopupRunOptions {
	readonly pipeline: TranslationPipeline;
	readonly to: LanguageCode;
	readonly sources?: readonly LanguageCode[];
	readonly private?: boolean;
	/** Displays the popup is placed on (default: the capture source's). */
	readonly displays?: () => readonly Display[];
	readonly settings?: Partial<SnipPopupSettings>;
}

export interface SnipPopupReport {
	readonly requestId: string | null;
	readonly placement: SnipPopupPlacement | null;
	readonly frame: Rect | null;
	readonly shown: boolean;
	/** Footer status after every push, consecutive repeats collapsed. */
	readonly statuses: string[];
	readonly pushes: number;
	readonly state: SnipPopupState | null;
	readonly harness: PopupHarness;
}

/**
 * A scripted Snip end to end, headless: region → capture → pipeline → popup state, with
 * the view's part played by FakePopupWindow (it reports `painted` at once).
 */
export async function runSnipPopup(
	capture: CaptureSource,
	region: Rect,
	o: SnipPopupRunOptions,
): Promise<SnipPopupReport> {
	const inner = pipelineRunner(capture, o.pipeline, {
		to: o.to,
		...(o.sources ? { sources: o.sources } : {}),
		...(o.private !== undefined ? { private: o.private } : {}),
	});
	let running: Promise<unknown> = Promise.resolve();
	const runner: SnipRunner = {
		snip: (...args) => {
			running = inner.snip(...args);
			return running;
		},
	};
	const h = popupHarness({
		displays: o.displays ?? (() => capture.displays()),
		runner,
		...(o.settings ? { settings: o.settings } : {}),
	});
	const statuses: string[] = [];
	const window = h.window;
	const send = window.send.bind(window);
	window.send = (m) => {
		send(m);
		const s = snipStatus(m.state);
		const text = s.kind === "translating" || s.kind === "partial" ? `${s.kind} ${s.done}/${s.total}` : s.kind;
		if (statuses.at(-1) !== text) statuses.push(text);
	};
	const id = h.controller.open(region);
	if (id) h.controller.painted(id);
	await running.catch(() => {});
	await Bun.sleep(0);
	return {
		requestId: id,
		placement: h.controller.placement,
		frame: h.controller.frame,
		shown: window.visible,
		statuses,
		pushes: window.messages.length,
		state: h.controller.state,
		harness: h,
	};
}

/** Human-readable report lines (`bun run harness snip --pipeline --popup`). Screen text is the scripted OCR's. */
export function popupLines(r: SnipPopupReport): string[] {
	const p = r.placement;
	const f = r.frame;
	const out = [
		`snip popup ${r.requestId ?? "-"}: ${p ? `${p.side} on display ${p.displayId}, width ${p.width}, max ${Math.round(p.maxHeight)}` : "no placement"}` +
			`${f ? `, frame ${f.x},${f.y} ${f.width}x${f.height}` : ""}, ${r.shown ? "shown" : "NOT shown"}, ${r.pushes} pushes`,
		`    status: ${r.statuses.join(" → ")}`,
	];
	const clip = r.harness.clipboard.at(-1);
	out.push(`    clipboard: ${clip === undefined ? "not written" : JSON.stringify(clip)}`);
	const s = r.state;
	if (!s) return out;
	out.push(
		`    phase ${s.phase}${s.error ? `, error ${s.error}` : ""}, provider ${s.provider.kind}${s.private ? ", private" : ""}`,
	);
	for (const b of s.blocks) {
		const shown = b.state === "done" && b.cls === "translate" ? b.translation : b.source;
		out.push(`    [${b.cls}/${b.state}] ${JSON.stringify(shown)}`);
	}
	return out;
}
