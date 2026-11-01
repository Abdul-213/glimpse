// What the Snip popup shows, as plain data (snip-popup.md §4, §13.2). The main process
// owns it: `reduceSnip` folds pipeline events and user intents into a `SnipPopupState`,
// the window controller pushes it to the view, and the view only renders it. Pure, so
// the reducer, the clipboard text and the status line are tested on Linux.
//
// Slot stability (§8): every recognised block keeps its slot, in reading order, from the
// moment it is known. A late translation for block 1 changes block 1 only.

import type { BlockId } from "../block.ts";
import type { LanguageCode } from "../language/code.ts";
import type { TextDirection } from "../language/script.ts";
import type { BlockClass, PipelineErrorKind, PipelineEvent } from "../pipeline/events.ts";
import type { Provenance, ProviderRef } from "../providers/provenance.ts";
import type { SegmentFailureKind } from "../providers/readiness.ts";

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
}

/** Footer provider indicator (GLIM-22, GLIM-80). */
export type SnipProviderBadge =
	| { readonly kind: "local" }
	| {
			readonly kind: "cloud";
			/** "Google Cloud Translation". */
			readonly name: string;
			/** Every cloud result came from the cache: "Sent to {provider} (remembered)". */
			readonly remembered: boolean;
			/** What left the device. */
			readonly sent: "text" | "image" | "both";
			readonly segments: number;
	  };

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
	/** Per-block language tags: the region mixes source languages, or the setting is on. */
	readonly alwaysShowLanguages: boolean;
	readonly skippedExpanded: boolean;
}

/** Things that change the popup, besides pipeline events. */
export type SnipAction =
	| {
			readonly type: "open";
			readonly requestId: string;
			readonly private?: boolean;
			readonly alwaysShowLanguages?: boolean;
	  }
	| { readonly type: "pipeline"; readonly event: PipelineEvent }
	| { readonly type: "toggleSkipped"; readonly expanded?: boolean };

/** S0: two static skeleton bars. */
export const OPENED_SKELETONS: readonly number[] = [70, 45];

export function initialSnipState(requestId: string, opts: { private?: boolean; alwaysShowLanguages?: boolean } = {}) {
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
		alwaysShowLanguages: opts.alwaysShowLanguages ?? false,
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
			});
		case "toggleSkipped":
			return { ...state, skippedExpanded: action.expanded ?? !state.skippedExpanded };
		case "pipeline":
			if (runOf(action.event) !== state.requestId) return state;
			return reducePipeline(state, action.event);
	}
}

function reducePipeline(state: SnipPopupState, event: PipelineEvent): SnipPopupState {
	switch (event.type) {
		case "started":
			return {
				...state,
				target: event.target,
				private: event.private,
				provider: badgeFromRefs(event.ocr, event.translation),
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
		case "packs":
			return state;
		case "translation": {
			const t = event.translation;
			const blocks = state.blocks.map((b): SnipBlock => {
				if (b.id !== t.blockId) return b;
				const promoted = b.cls === "skip" ? { cls: "translate" as const, promoted: true } : {};
				if (!t.final) return { ...b, ...promoted, state: "pending", translation: t.text };
				if (t.failure) return { ...b, ...promoted, state: "failed", translation: null, failure: t.failure.kind };
				return { ...b, ...promoted, state: "done", translation: t.text, failure: null };
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
			const badge = badgeFromResult(state.provider, r.ocr, r.translators, Object.keys(r.translations).length);
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
	const cloudOcr = ocr?.kind === "cloud";
	const cloudTr = translation?.kind === "cloud";
	if (!cloudOcr && !cloudTr) return { kind: "local" };
	const name = (cloudTr ? translation?.name : ocr?.name) ?? "";
	return {
		kind: "cloud",
		name,
		remembered: false,
		sent: cloudOcr && cloudTr ? "both" : cloudOcr ? "image" : "text",
		segments: 0,
	};
}

function badgeFromResult(
	before: SnipProviderBadge,
	ocr: Provenance | null,
	translators: readonly Provenance[],
	segments: number,
): SnipProviderBadge {
	const cloudOcr = ocr?.kind === "cloud";
	const cloud = translators.filter((t) => t.kind === "cloud");
	if (!cloudOcr && cloud.length === 0) return before.kind === "cloud" && !ocr ? before : { kind: "local" };
	const first = cloud[0];
	return {
		kind: "cloud",
		name: first?.name ?? ocr?.name ?? "",
		remembered: cloud.length > 0 && cloud.every((t) => t.remembered === true) && !cloudOcr,
		sent: cloudOcr && cloud.length > 0 ? "both" : cloudOcr ? "image" : "text",
		segments,
	};
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
	| { readonly kind: "partial"; readonly done: number; readonly total: number };

export function snipStatus(s: SnipPopupState): SnipStatus {
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
			return { kind: "none" };
	}
}
