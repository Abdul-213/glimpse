// What the Snip popup shows, as plain data (snip-popup.md §4, §13.2). The main process
// owns it: `reduceSnip` folds pipeline events and user intents into a `SnipPopupState`,
// the window controller pushes it to the view, and the view only renders it. Pure, so
// the reducer, the clipboard text and the status line are tested on Linux.
//
// Slot stability (§8): every recognised block keeps its slot, in reading order, from the
// moment it is known. A late translation for block 1 changes block 1 only.

import type { BlockId } from "../block.ts";
import type { LanguageCode } from "../language/code.ts";
import { localOcrIsPartial } from "../language/ocr.ts";
import type { TextDirection } from "../language/script.ts";
import type { InstallState } from "../models/install-state.ts";
import type { BlockClass, PipelineErrorKind, PipelineEvent } from "../pipeline/events.ts";
import type { Provenance, ProviderRef } from "../providers/provenance.ts";
import type { PackKind, PackRow, SegmentFailureKind } from "../providers/readiness.ts";

/** One block's state in the popup. */
export type SnipBlockState =
	/** Translate-class block without a final translation yet: its source (or partial text) shows. */
	| "pending"
	/** Final: translated, or shown as-is (neutral, target-language). */
	| "done"
	/** Translation failed; the source stays visible with "Not translated". */
	| "failed"
	/** Waiting for a language pack (a pack row at the top of the list names it). */
	| "waiting";

export interface SnipBlock {
	readonly id: BlockId;
	/** Reading order, 0-based. */
	readonly order: number;
	readonly cls: BlockClass;
	/** OCR text (lines joined with "\n"). */
	readonly source: string;
	/** Detected source language, if known. */
	readonly lang: LanguageCode | null;
	readonly direction: TextDirection;
	readonly state: SnipBlockState;
	/**
	 * Final translation (`done`), or the streamed text so far for a pending block
	 * (translated sentences + remaining source). Null when nothing has arrived.
	 */
	readonly translation: string | null;
	readonly failure: SegmentFailureKind | null;
	/** Skipped block the user asked to translate ("Translate these"): it joins the list. */
	readonly promoted?: boolean;
	/** Who produced the final translation (GLIM-80: the badge after a follow-up). */
	readonly provider?: Provenance | null;
}

/** Footer provider indicator (GLIM-22, GLIM-80). */
export type SnipProviderBadge =
	| { readonly kind: "local" }
	| {
			readonly kind: "cloud";
			/** "Google Cloud Translation": the cloud translator, else the cloud OCR provider. */
			readonly name: string;
			/** Registry id of `name`'s provider; main looks up its short name with it. */
			readonly id: string;
			/** The cloud OCR provider's name when the image went to the cloud. */
			readonly ocrName: string | null;
			/** The cloud translator's name when text went to the cloud. */
			readonly translatorName: string | null;
			/** Every cloud result came from the cache: "Sent to {provider} (remembered)". */
			readonly remembered: boolean;
			/** What left the device. */
			readonly sent: "text" | "image" | "both";
			readonly segments: number;
	  };

/** One missing language pack row at the top of the list (§2.2), or the E2 body's download. */
export interface SnipPackRow {
	readonly lang: LanguageCode;
	readonly state: "missing" | "downloading" | "offline" | "failed";
	/** Download size; 0 when unknown. */
	readonly bytes: number;
	/** Bytes received / total while downloading. */
	readonly received: number | null;
	readonly total: number | null;
	/** Model manager resource ids to download for this language. */
	readonly resourceIds: readonly string[];
	/** Blocks waiting on this pack. */
	readonly blockIds: readonly string[];
	/** What the download is (GLIM-138); absent = a language pack. */
	readonly kind?: PackKind;
}

export type SnipPhase = "opened" | "detected" | "recognised" | "translating" | "done" | "error";

export interface SnipPopupState {
	/** The pipeline run id; events for any other run are dropped. */
	readonly requestId: string;
	readonly phase: SnipPhase;
	readonly target: LanguageCode | null;
	readonly private: boolean;
	/** Skeleton bar widths (%) before OCR text exists: two placeholders, then one per detected box. */
	readonly skeletons: readonly number[];
	/** Every recognised block (skipped ones too), in reading order. */
	readonly blocks: readonly SnipBlock[];
	readonly progress: { readonly done: number; readonly total: number } | null;
	/** Whole-run error state (E1-E7), once the run is done. */
	readonly error: PipelineErrorKind | null;
	readonly provider: SnipProviderBadge;
	/**
	 * The providers the run started with (from `started`): who an E3 error names, and the
	 * OCR side of the badge after a follow-up.
	 */
	readonly ocrProvider: ProviderRef | null;
	readonly translatorProvider: ProviderRef | null;
	/** Missing packs, one row per source language, first-seen order. */
	readonly packs: readonly SnipPackRow[];
	/** Translation work started after the run finished (Retry, a pack landing, Translate these). */
	readonly followUps: number;
	/** Per-block language tags: the region mixes source languages, or the setting is on. */
	readonly alwaysShowLanguages: boolean;
	/** Original view (Ctrl/⌘⇧O, §4 S6): every block shows its OCR text as the content. */
	readonly view: "translation" | "original";
	/** Settings › "Show original under translation" (§4 S5). */
	readonly showOriginalUnder: boolean;
	/** Settings › "Copy translation after Snip" (§6, on by default). */
	readonly autoCopy: boolean;
	/** The translation went on the clipboard automatically at least once. */
	readonly autoCopied: boolean;
	/** "Copied" shows in the footer for 2 s after a write (§2.4). */
	readonly copied: "translation" | "original" | null;
	readonly skippedExpanded: boolean;
}

/** Things that change the popup, besides pipeline events. */
export type SnipAction =
	| {
			readonly type: "open";
			readonly requestId: string;
			readonly private?: boolean;
			readonly alwaysShowLanguages?: boolean;
			readonly showOriginalUnder?: boolean;
			readonly autoCopy?: boolean;
	  }
	| { readonly type: "pipeline"; readonly event: PipelineEvent }
	| { readonly type: "toggleSkipped"; readonly expanded?: boolean }
	/** The clipboard was written (auto-copy, Ctrl/⌘C, Copy original). */
	| { readonly type: "copied"; readonly what: "translation" | "original"; readonly auto?: boolean }
	/** The 2 s "Copied" confirmation is over. */
	| { readonly type: "copiedExpired" }
	/** Flip between the translation and the original (`on` sets it). */
	| { readonly type: "toggleOriginal"; readonly on?: boolean }
	/** A pack's install state changed (the model manager's states for that row's resources). */
	| { readonly type: "packInstall"; readonly lang: LanguageCode; readonly states: readonly InstallState[] }
	/**
	 * Follow-up translation work (Retry, a pack landing, "Translate these") started or
	 * finished; `blockIds` go back to pending when it starts.
	 */
	| {
			readonly type: "followUp";
			readonly phase: "start";
			readonly blockIds: readonly string[];
			readonly promote?: boolean;
	  }
	| { readonly type: "followUp"; readonly phase: "end" };

/** S0: two static skeleton bars. */
export const OPENED_SKELETONS: readonly number[] = [70, 45];

export function initialSnipState(
	requestId: string,
	opts: { private?: boolean; alwaysShowLanguages?: boolean; showOriginalUnder?: boolean; autoCopy?: boolean } = {},
) {
	const state: SnipPopupState = {
		requestId,
		phase: "opened",
		target: null,
		private: opts.private ?? false,
		skeletons: OPENED_SKELETONS,
		blocks: [],
		progress: null,
		error: null,
		provider: { kind: "local" },
		ocrProvider: null,
		translatorProvider: null,
		packs: [],
		followUps: 0,
		alwaysShowLanguages: opts.alwaysShowLanguages ?? false,
		view: "translation",
		showOriginalUnder: opts.showOriginalUnder ?? false,
		autoCopy: opts.autoCopy ?? true,
		autoCopied: false,
		copied: null,
		skippedExpanded: false,
	};
	return state;
}

/** Skeleton width: the box's share of the region width, clamped to 30-100 % (§2.2). */
export function skeletonShare(boxWidth: number, regionWidth: number): number {
	if (!(regionWidth > 0) || !Number.isFinite(boxWidth)) return 100;
	return Math.round(Math.min(100, Math.max(30, (boxWidth / regionWidth) * 100)));
}

const runOf = (event: PipelineEvent): string => event.runId;

export function reduceSnip(state: SnipPopupState, action: SnipAction): SnipPopupState {
	switch (action.type) {
		case "open":
			return initialSnipState(action.requestId, {
				...(action.private !== undefined ? { private: action.private } : {}),
				...(action.alwaysShowLanguages !== undefined ? { alwaysShowLanguages: action.alwaysShowLanguages } : {}),
				...(action.showOriginalUnder !== undefined ? { showOriginalUnder: action.showOriginalUnder } : {}),
				...(action.autoCopy !== undefined ? { autoCopy: action.autoCopy } : {}),
			});
		case "copied":
			return { ...state, copied: action.what, autoCopied: state.autoCopied || action.auto === true };
		case "copiedExpired":
			return state.copied === null ? state : { ...state, copied: null };
		case "toggleOriginal": {
			const on = action.on ?? state.view === "translation";
			const view = on ? "original" : "translation";
			return view === state.view ? state : { ...state, view };
		}
		case "toggleSkipped":
			return { ...state, skippedExpanded: action.expanded ?? !state.skippedExpanded };
		case "pipeline":
			if (runOf(action.event) !== state.requestId) return state;
			return reducePipeline(state, action.event);
		case "packInstall":
			return reducePackInstall(state, action.lang, action.states);
		case "followUp":
			return action.phase === "start"
				? startFollowUp(state, action.blockIds, action.promote ?? false)
				: endFollowUp(state);
	}
}

function startFollowUp(state: SnipPopupState, ids: readonly string[], promote: boolean): SnipPopupState {
	const set = new Set(ids);
	const blocks = state.blocks.map((b): SnipBlock => {
		if (!set.has(b.id)) return b;
		const cls = promote && b.cls === "skip" ? "translate" : b.cls;
		return {
			...b,
			cls,
			...(promote && b.cls === "skip" ? { promoted: true } : {}),
			state: "pending",
			translation: null,
			failure: null,
		};
	});
	const finished = state.phase === "done" || state.phase === "error";
	return {
		...state,
		blocks,
		followUps: state.followUps + 1,
		...(finished ? { phase: "translating" as const, error: null } : {}),
		progress: { done: 0, total: ids.length },
		skippedExpanded: promote ? false : state.skippedExpanded,
	};
}

function endFollowUp(state: SnipPopupState): SnipPopupState {
	const followUps = Math.max(0, state.followUps - 1);
	if (followUps > 0 || state.phase !== "translating") return { ...state, followUps };
	const translate = state.blocks.filter((b) => b.cls === "translate");
	const allWaiting = translate.length > 0 && translate.every((b) => b.state === "waiting" || b.state === "failed");
	const someWaiting = translate.some((b) => b.state === "waiting");
	// The badge follows what produced the text now on screen ("Translate on this device", GLIM-80).
	const translators = blockProviders(state.blocks);
	const provider =
		translators.length > 0 ? badgeFor(state.ocrProvider, translators, countTranslated(state.blocks)) : state.provider;
	return {
		...state,
		followUps,
		provider,
		phase: allWaiting && someWaiting ? "error" : "done",
		error: allWaiting && someWaiting ? "packMissing" : null,
		progress: null,
	};
}

function reducePackInstall(state: SnipPopupState, lang: LanguageCode, states: readonly InstallState[]): SnipPopupState {
	const row = state.packs.find((p) => p.lang === lang);
	if (!row) return state;
	const view = packRowState(row, states);
	if (view === "installed") {
		return { ...state, packs: state.packs.filter((p) => p !== row) };
	}
	return { ...state, packs: state.packs.map((p) => (p === row ? view : p)) };
}

/** A row's state from its resources' install states: "installed" once every one is in. */
export function packRowState(row: SnipPackRow, states: readonly InstallState[]): SnipPackRow | "installed" {
	if (states.length > 0 && states.every((s) => s.status === "installed")) return "installed";
	const failed = states.some((s) => s.status === "failed");
	if (failed) return { ...row, state: "failed", received: null, total: null };
	const busy = states.filter((s) => s.status !== "missing" && s.status !== "installed");
	if (busy.length === 0)
		return { ...row, state: row.state === "offline" ? "offline" : "missing", received: null, total: null };
	let received = 0;
	let total = 0;
	for (const s of states) {
		if (s.status !== "downloading") continue;
		received += s.receivedBytes;
		total += s.totalBytes;
	}
	const size = total > 0 ? total : row.bytes;
	return { ...row, state: "downloading", received, total: size > 0 ? size : null };
}

/** A pipeline pack row as the popups show it (Snip and Live, GLIM-123). */
export const packRowView = (p: PackRow): SnipPackRow => ({
	lang: p.lang,
	state: p.state,
	bytes: p.bytes,
	received: p.state === "downloading" && p.progress !== null && p.bytes > 0 ? Math.round(p.progress * p.bytes) : null,
	total: p.state === "downloading" && p.bytes > 0 ? p.bytes : null,
	resourceIds: p.resourceIds,
	blockIds: p.segmentIds,
	...(p.kind ? { kind: p.kind } : {}),
});

function reducePipeline(state: SnipPopupState, event: PipelineEvent): SnipPopupState {
	switch (event.type) {
		case "started":
			return {
				...state,
				target: event.target,
				private: event.private,
				provider: badgeFromRefs(event.ocr, event.translation),
				ocrProvider: event.ocr,
				translatorProvider: event.translation,
			};
		case "detected": {
			if (state.blocks.length > 0) return state;
			const width = event.image.width;
			// Rough reading order for the placeholders: top to bottom, then left to right.
			const boxes = [...event.boxes].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
			return {
				...state,
				phase: "detected",
				skeletons: boxes.length > 0 ? boxes.map((b) => skeletonShare(b.box.width, width)) : state.skeletons,
			};
		}
		case "recognised": {
			const blocks = [...event.blocks]
				.sort((a, b) => a.order - b.order)
				.map(
					(b): SnipBlock => ({
						id: b.id,
						order: b.order,
						cls: b.cls,
						source: b.text,
						lang: b.lang,
						direction: b.direction,
						state: b.cls === "translate" ? (b.waitingForPack ? "waiting" : "pending") : "done",
						translation: null,
						failure: null,
					}),
				);
			const total = blocks.filter((b) => b.state === "pending").length;
			return {
				...state,
				phase: "recognised",
				skeletons: [],
				blocks,
				progress: total > 0 ? { done: 0, total } : null,
			};
		}
		case "packs": {
			const rows = [...state.packs];
			for (const p of event.rows) {
				const i = rows.findIndex((r) => r.lang === p.lang);
				if (i >= 0) rows[i] = packRowView(p);
				else rows.push(packRowView(p));
			}
			// Blocks named by a row wait for it.
			const waiting = new Set(event.rows.flatMap((p) => p.segmentIds));
			const blocks = state.blocks.map(
				(b): SnipBlock => (waiting.has(b.id) && b.state === "pending" ? { ...b, state: "waiting" } : b),
			);
			return { ...state, packs: rows, blocks };
		}
		case "translation": {
			const t = event.translation;
			const blocks = state.blocks.map((b): SnipBlock => {
				if (b.id !== t.blockId) return b;
				const promoted = b.cls === "skip" ? { cls: "translate" as const, promoted: true } : {};
				if (!t.final) return { ...b, ...promoted, state: "pending", translation: t.text };
				if (t.failure) return { ...b, ...promoted, state: "failed", translation: null, failure: t.failure.kind };
				return { ...b, ...promoted, state: "done", translation: t.text, failure: null, provider: t.provider };
			});
			return { ...state, phase: state.phase === "done" ? state.phase : "translating", blocks };
		}
		case "progress":
			return { ...state, progress: { done: event.done, total: event.total } };
		case "done": {
			const r = event.result;
			// A `recognised` event that went missing: take the blocks from the result.
			const blocks =
				state.blocks.length > 0 || r.blocks.length === 0
					? state.blocks
					: reducePipeline(state, { type: "recognised", runId: state.requestId, blocks: r.blocks }).blocks;
			// A cloud timeout (E3) may have delivered the text without an answer: the pill stays (GLIM-80).
			// The spend guard (GLIM-120) stopped the request before it left: the pill must not say "Sent to".
			const badge =
				r.error?.kind === "providerTimeout" && state.provider.kind === "cloud"
					? state.provider
					: badgeFromResult(
							r.error?.kind === "spendCap" ? { kind: "local" } : state.provider,
							r.ocr,
							r.translators,
							Object.keys(r.translations).length,
						);
			return {
				...state,
				phase: r.error ? "error" : "done",
				error: r.error?.kind ?? null,
				skeletons: [],
				blocks,
				provider: badge,
				skippedExpanded: r.error?.kind === "nothingToTranslate" ? true : state.skippedExpanded,
			};
		}
	}
}

function badgeFromRefs(ocr: ProviderRef | null, translation: ProviderRef | null): SnipProviderBadge {
	const cloudOcr = ocr?.kind === "cloud" ? ocr : null;
	const cloudTr = translation?.kind === "cloud" ? translation : null;
	const main = cloudTr ?? cloudOcr;
	if (!main) return { kind: "local" };
	return {
		kind: "cloud",
		name: main.name,
		id: main.id,
		ocrName: cloudOcr?.name ?? null,
		translatorName: cloudTr?.name ?? null,
		remembered: false,
		sent: cloudOcr && cloudTr ? "both" : cloudOcr ? "image" : "text",
		segments: 0,
	};
}

/** The badge for an OCR provider and the translators that produced the results. */
function badgeFor(ocr: ProviderRef | null, translators: readonly Provenance[], segments: number): SnipProviderBadge {
	const cloudOcr = ocr?.kind === "cloud" ? ocr : null;
	const cloud = translators.filter((t) => t.kind === "cloud");
	const first = cloud[0];
	const main = first ?? cloudOcr;
	if (!main) return { kind: "local" };
	return {
		kind: "cloud",
		name: main.name,
		id: main.id,
		ocrName: cloudOcr?.name ?? null,
		translatorName: first?.name ?? null,
		remembered: cloud.length > 0 && cloud.every((t) => t.remembered === true) && !cloudOcr,
		sent: cloudOcr && first ? "both" : cloudOcr ? "image" : "text",
		segments,
	};
}

function blockProviders(blocks: readonly SnipBlock[]): Provenance[] {
	const out = new Map<string, Provenance>();
	for (const b of blocks) {
		if (b.state !== "done" || !b.provider) continue;
		const key = `${b.provider.id}|${b.provider.remembered ? 1 : 0}`;
		if (!out.has(key)) out.set(key, b.provider);
	}
	return [...out.values()];
}

const countTranslated = (blocks: readonly SnipBlock[]) =>
	blocks.filter((b) => b.cls === "translate" && b.state === "done" && b.provider).length;

function badgeFromResult(
	before: SnipProviderBadge,
	ocr: Provenance | null,
	translators: readonly Provenance[],
	segments: number,
): SnipProviderBadge {
	const cloudOcr = ocr?.kind === "cloud";
	const cloud = translators.filter((t) => t.kind === "cloud");
	if (!cloudOcr && cloud.length === 0) return before.kind === "cloud" && !ocr ? before : { kind: "local" };
	return badgeFor(ocr, translators, segments);
}

// ---- Derived values the view renders ------------------------------------------------

/** Blocks shown in the list (everything but skipped ones that weren't promoted). */
export const listedBlocks = (s: SnipPopupState): SnipBlock[] => s.blocks.filter((b) => b.cls !== "skip");

/** Skipped blocks, for the "N blocks skipped" line. */
export const skippedBlocks = (s: SnipPopupState): SnipBlock[] => s.blocks.filter((b) => b.cls === "skip");

/** Distinct languages of the skipped blocks, first-seen order (codes; the view names them). */
export function skippedLanguages(s: SnipPopupState): LanguageCode[] {
	const out: LanguageCode[] = [];
	for (const b of skippedBlocks(s)) if (b.lang && !out.includes(b.lang)) out.push(b.lang);
	return out;
}

/**
 * Languages in this Snip that on-device OCR reads only partly (GLIM-126: Vietnamese tone
 * marks), when the text was read on this device. The popup suggests cloud OCR for them.
 */
export function partialOcrLanguages(s: SnipPopupState): LanguageCode[] {
	if (s.ocrProvider?.kind !== "local") return [];
	const out: LanguageCode[] = [];
	for (const b of listedBlocks(s)) if (b.lang && localOcrIsPartial(b.lang) && !out.includes(b.lang)) out.push(b.lang);
	return out;
}

/** Language tags on translate-class blocks: two or more source languages, or the setting (§2.2). */
export function showLanguageTags(s: SnipPopupState): boolean {
	if (s.alwaysShowLanguages) return true;
	const langs = new Set(s.blocks.filter((b) => b.cls === "translate" && b.lang).map((b) => b.lang));
	return langs.size >= 2;
}

/** Footer status line (§2.4, §4). The view turns it into copy. */
export type SnipStatus =
	| { readonly kind: "none" }
	| { readonly kind: "reading" }
	| { readonly kind: "translating"; readonly done: number; readonly total: number }
	| { readonly kind: "partial"; readonly done: number; readonly total: number }
	/** Errors never touch the clipboard (§6). */
	| { readonly kind: "clipboardUnchanged" }
	/** Original view is on (§4 S6). */
	| { readonly kind: "original" }
	/** The clipboard was just written: "Copied" with a check, for 2 s. */
	| { readonly kind: "copied" };

export function snipStatus(s: SnipPopupState): SnipStatus {
	if (s.copied && s.phase !== "error") return { kind: "copied" };
	if (s.view === "original" && s.phase !== "error" && s.blocks.length > 0) return { kind: "original" };
	switch (s.phase) {
		case "opened":
		case "detected":
			return { kind: "reading" };
		case "recognised":
		case "translating":
			return s.progress ? { kind: "translating", ...s.progress } : { kind: "none" };
		case "done": {
			const translate = s.blocks.filter((b) => b.cls === "translate");
			const failed = translate.filter((b) => b.state === "failed" || b.state === "waiting").length;
			return failed > 0
				? { kind: "partial", done: translate.length - failed, total: translate.length }
				: { kind: "none" };
		}
		case "error":
			return { kind: "clipboardUnchanged" };
	}
}

/**
 * Should the translation go on the clipboard now (§6)? The run is done without an error,
 * at least one block was translated, and auto-copy is on. The controller writes when this
 * turns true and the text differs from what it last wrote ("Translate these" rewrites
 * once). Errors never touch the clipboard; Live never uses this.
 */
export function shouldAutoCopy(s: SnipPopupState): boolean {
	return (
		s.autoCopy &&
		s.phase === "done" &&
		s.error === null &&
		s.followUps === 0 &&
		s.blocks.some((b) => b.cls === "translate" && b.state === "done")
	);
}
