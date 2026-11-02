// What the docked Live popup shows, as plain data (live-popup.md §2, §4, §5, §8). The main
// process owns it: `reduceLivePopup` folds the session's `LiveSessionEvent`s and the user's
// intents into a `LivePopupState`, the window controller pushes it to the view, and the view
// renders it, keyed by block id, so unchanged blocks keep their DOM nodes (GLIM-79).
//
// Change marks (§2.5): each change set that lands gets a new `changeSeq`; its blocks carry it
// as `changeId` and every older mark is cleared at once. A changed block flashes when its new
// content is *revealed*:
// - its new translation is already known (cache / frame ring): at once;
// - otherwise its old translation is held for up to 600 ms (§8 "Hold before swapping"). The
//   translation arriving in time swaps and flashes; `holdExpired` (the controller's timer)
//   shows the new source in source style and flashes then, and the translation that comes
//   later crossfades in without a second flash;
// - an added block has nothing to hold: its source shows pending and flashes at once.
// Neutral and skip blocks update silently (never marked); skip blocks live in the skipped line.
//
// Pure: no timers here. `heldBlocks(prev, next)` tells the controller which holds to time and
// `revealedTranslations(prev, next)` which translations to announce (§10, GLIM-92).

import type { Rect } from "../geometry.ts";
import type { LanguageCode } from "../language/code.ts";
import type { TextDirection } from "../language/script.ts";
import type { InstallState } from "../models/install-state.ts";
import type { BlockClass } from "../pipeline/events.ts";
import type {
	LiveError,
	LivePauseReason,
	LiveSessionEvent,
	LiveSessionProviders,
	LiveStatus,
} from "../pipeline/live-events.ts";
import type { ProviderRef } from "../providers/provenance.ts";
import { packRowState, packRowView, type SnipPackRow } from "./snip-state.ts";

/** A missing language pack row at the top of the Live list (L12): the Snip pack row. */
export type LivePackRow = SnipPackRow;

/** How long a changed block keeps its old translation while the new one is on its way (§8). */
export const LIVE_HOLD_MS = 600;

export interface LivePopupBlock {
	readonly id: string;
	readonly order: number;
	readonly cls: BlockClass;
	readonly lang: LanguageCode | null;
	readonly direction: TextDirection;
	/** Region-local image px (the linked box on the frame). */
	readonly box: Rect;
	readonly source: string;
	/** The translation on screen: the new one, or the old one while `holding`. */
	readonly translation: string | null;
	/** Streamed text so far while pending (translated sentences + remaining source). */
	readonly partial: string | null;
	/** Translate-class block showing its source in source style (no translation yet). */
	readonly pending: boolean;
	/** The old translation is held for up to 600 ms; `source` is already the new text. */
	readonly holding: boolean;
	readonly failed: boolean;
	readonly waitingForPack: boolean;
	/** The change set this block belongs to (mark + flash); null = unmarked. */
	readonly changeId: number | null;
	/** The settled capture this block's content comes from (older translations are dropped). */
	readonly frameSeq: number;
}

/** The status the popup shows: the session's, plus the consent question and closed. */
export type LivePopupStatus = LiveStatus | "consent" | "closed";

export interface LiveConsentQuestion {
	readonly providers: readonly ProviderRef[];
	readonly canRemember: boolean;
	/** Offer "Use on-device" (GLIM-122). */
	readonly localAvailable: boolean;
	readonly reason: "cloud-ocr" | "cloud-translation";
}

export interface LivePopupState {
	readonly sessionId: string | null;
	readonly status: LivePopupStatus;
	readonly reason: LivePauseReason | null;
	readonly error: LiveError | null;
	/** Not capturing: blocks dim and the state row says how old they are. */
	readonly stale: boolean;
	/** Epoch ms of the capture the blocks come from. */
	readonly capturedAt: number | null;
	/** Display order; skip-class blocks included (the view puts them in the skipped line). */
	readonly blocks: readonly LivePopupBlock[];
	/** The latest change set's id (0 before the first). */
	readonly changeSeq: number;
	readonly frameSeq: number;
	readonly region: Rect | null;
	/** Size of the captured image the block boxes are in. */
	readonly image: { readonly width: number; readonly height: number } | null;
	/** The skipped line's expansion persists for the session (§2.5). */
	readonly skippedExpanded: boolean;
	readonly private: boolean;
	readonly providers: LiveSessionProviders;
	readonly consent: LiveConsentQuestion | null;
	/** L12: one row per source language the shown blocks wait for, first-seen order. */
	readonly packs: readonly LivePackRow[];
}

export type LivePopupAction =
	| { readonly type: "session"; readonly event: LiveSessionEvent }
	/** The 600 ms hold for a block ran out (controller timer). */
	| { readonly type: "holdExpired"; readonly id: string; readonly frameSeq: number }
	/** App-wide Private changed (tray or popup). */
	| { readonly type: "private"; readonly on: boolean }
	| { readonly type: "skipped"; readonly expanded: boolean }
	/** A pack row's resources changed install state (the model manager, GLIM-123). */
	| { readonly type: "packInstall"; readonly lang: LanguageCode; readonly states: readonly InstallState[] };

export const initialLivePopupState: LivePopupState = {
	sessionId: null,
	status: "closed",
	reason: null,
	error: null,
	stale: false,
	capturedAt: null,
	blocks: [],
	changeSeq: 0,
	frameSeq: 0,
	region: null,
	image: null,
	skippedExpanded: false,
	private: false,
	providers: { cloud: null, localOnly: false },
	consent: null,
	packs: [],
};

export function reduceLivePopup(state: LivePopupState, action: LivePopupAction): LivePopupState {
	switch (action.type) {
		case "private":
			return state.private === action.on ? state : { ...state, private: action.on };
		case "skipped":
			return state.skippedExpanded === action.expanded ? state : { ...state, skippedExpanded: action.expanded };
		case "holdExpired":
			return holdExpired(state, action.id, action.frameSeq);
		case "packInstall":
			return packInstall(state, action.lang, action.states);
		case "session":
			return onEvent(state, action.event);
	}
}

function onEvent(state: LivePopupState, event: LiveSessionEvent): LivePopupState {
	if (event.type === "opened") {
		if (event.sessionId === state.sessionId) {
			return { ...state, region: event.region, providers: event.providers, private: event.private };
		}
		return {
			...initialLivePopupState,
			sessionId: event.sessionId,
			status: "starting",
			region: event.region,
			providers: event.providers,
			private: event.private,
		};
	}
	if (event.sessionId !== state.sessionId) return state;
	switch (event.type) {
		case "consent":
			return {
				...state,
				status: "consent",
				consent: {
					providers: event.providers,
					canRemember: event.canRemember,
					reason: event.reason,
					localAvailable: event.localAvailable ?? event.reason !== "cloud-ocr",
				},
			};
		case "status":
			if (event.status === "stopped") return { ...initialLivePopupState, private: state.private };
			return {
				...state,
				status: event.status,
				reason: event.reason,
				error: event.error,
				stale: event.stale,
				capturedAt: event.capturedAt ?? state.capturedAt,
				consent: null,
			};
		case "frame":
			return onFrame(state, event);
		case "translation":
			return onTranslation(state, event);
		case "packs":
			return onPacks(state, event.rows);
	}
}

/**
 * The latest capture's pack rows replace the shown ones. A row this popup started
 * downloading keeps its progress (the next `packInstall` updates it), so a frame read before
 * the model manager saw the download doesn't flip it back to "Download".
 */
function onPacks(state: LivePopupState, rows: Extract<LiveSessionEvent, { type: "packs" }>["rows"]): LivePopupState {
	if (rows.length === 0 && state.packs.length === 0) return state;
	const before = new Map(state.packs.map((p) => [p.lang, p]));
	const packs = rows.map((r) => {
		const next = packRowView(r);
		const prev = before.get(r.lang);
		return prev?.state === "downloading" && next.state !== "downloading"
			? { ...next, state: prev.state, received: prev.received, total: prev.total }
			: next;
	});
	return { ...state, packs };
}

function packInstall(state: LivePopupState, lang: LanguageCode, states: readonly InstallState[]): LivePopupState {
	const row = state.packs.find((p) => p.lang === lang);
	if (!row) return state;
	const view = packRowState(row, states);
	const packs =
		view === "installed" ? state.packs.filter((p) => p !== row) : state.packs.map((p) => (p === row ? view : p));
	return { ...state, packs };
}

function onFrame(state: LivePopupState, f: Extract<LiveSessionEvent, { type: "frame" }>): LivePopupState {
	const landed = f.changeSet.length > 0;
	const seq = landed ? state.changeSeq + 1 : state.changeSeq;
	const inSet = new Set(f.changeSet);
	const prevById = new Map(state.blocks.map((b) => [b.id, b]));
	const next = new Map<string, LivePopupBlock>();
	for (const u of f.upserts) {
		const prev = prevById.get(u.id);
		const changed = inSet.has(u.id);
		const base = {
			id: u.id,
			order: u.order,
			cls: u.cls,
			lang: u.lang,
			direction: u.direction,
			box: u.box,
			source: u.source,
			failed: u.failed,
			waitingForPack: u.waitingForPack,
			partial: null,
			frameSeq: f.frameSeq,
		};
		let block: LivePopupBlock;
		if (u.cls !== "translate" || u.translation !== null || u.failed || u.waitingForPack) {
			// Known at once (a cache or frame-ring hit), or nothing to translate: reveal now.
			block = { ...base, translation: u.translation, pending: false, holding: false, changeId: changed ? seq : null };
		} else if (changed && prev && prev.cls === "translate" && prev.translation !== null && !prev.holding) {
			// §8: hold the old translation up to 600 ms; marked when revealed.
			block = { ...base, translation: prev.translation, pending: false, holding: true, changeId: null };
		} else {
			block = { ...base, translation: null, pending: true, holding: false, changeId: changed ? seq : null };
		}
		if (!changed && prev && !landed) {
			// A silent update (class or language flip) keeps the current mark.
			block = { ...block, changeId: prev.changeId };
		}
		next.set(u.id, block);
	}
	const blocks: LivePopupBlock[] = [];
	f.order.forEach((id, order) => {
		const b = next.get(id) ?? prevById.get(id);
		if (!b) return;
		let out = b;
		if (!next.has(id) && landed) {
			// Only the latest change set is marked; a hold from an older set ends unmarked.
			out = b.holding
				? { ...b, holding: false, translation: null, pending: true, changeId: null }
				: b.changeId === null
					? b
					: { ...b, changeId: null };
		}
		blocks.push(out.order === order ? out : { ...out, order });
	});
	return {
		...state,
		blocks,
		changeSeq: seq,
		frameSeq: f.frameSeq,
		capturedAt: f.capturedAt,
		region: f.region,
		image: f.image,
	};
}

function onTranslation(state: LivePopupState, t: Extract<LiveSessionEvent, { type: "translation" }>): LivePopupState {
	const i = state.blocks.findIndex((b) => b.id === t.id);
	const b = state.blocks[i];
	if (!b || t.frameSeq < b.frameSeq) return state;
	let next: LivePopupBlock;
	if (!t.final) {
		if (b.holding || !b.pending) return state;
		next = { ...b, partial: t.text };
	} else if (t.failed) {
		next = {
			...b,
			translation: null,
			partial: null,
			pending: false,
			holding: false,
			failed: true,
			changeId: b.holding ? state.changeSeq : b.changeId,
		};
	} else {
		next = {
			...b,
			translation: t.text,
			partial: null,
			pending: false,
			failed: false,
			holding: false,
			// The swap after a hold flashes; a translation replacing pending source crossfades
			// in without a second flash (its mark is already there).
			changeId: b.holding ? state.changeSeq : b.changeId,
		};
	}
	const blocks = state.blocks.slice();
	blocks[i] = next;
	return { ...state, blocks };
}

function holdExpired(state: LivePopupState, id: string, frameSeq: number): LivePopupState {
	const i = state.blocks.findIndex((b) => b.id === id);
	const b = state.blocks[i];
	if (!b?.holding || b.frameSeq !== frameSeq) return state;
	const blocks = state.blocks.slice();
	blocks[i] = { ...b, holding: false, translation: null, pending: true, changeId: state.changeSeq };
	return { ...state, blocks };
}

/** Blocks that started holding between two states: the controller times them (600 ms). */
export function heldBlocks(prev: LivePopupState, next: LivePopupState): { id: string; frameSeq: number }[] {
	const before = new Map(prev.blocks.map((b) => [b.id, b]));
	return next.blocks
		.filter((b) => b.holding && !(before.get(b.id)?.holding && before.get(b.id)?.frameSeq === b.frameSeq))
		.map((b) => ({ id: b.id, frameSeq: b.frameSeq }));
}

/**
 * Translations of the latest change set that became visible between two states, in reading
 * order: what a screen reader should hear (§10). Unmarked blocks (first fill, silent
 * updates) are never announced.
 */
export function revealedTranslations(prev: LivePopupState, next: LivePopupState): string[] {
	if (next.sessionId !== prev.sessionId) return [];
	const before = new Map(prev.blocks.map((b) => [b.id, b]));
	const out: string[] = [];
	for (const b of next.blocks) {
		if (b.changeId === null || b.cls === "skip" || b.cls === "neutral") continue;
		const text = b.cls === "target" ? b.source : b.translation;
		if (text === null || b.holding || b.pending) continue;
		const p = before.get(b.id);
		if (p && p.changeId === b.changeId && p.translation === b.translation && !p.pending && !p.holding) continue;
		out.push(text);
	}
	return out;
}

/** The strip's dot and label (live-popup.md §2.2, §4). */
export interface LiveStrip {
	readonly dot: "running" | "updating" | "paused" | "consent" | "error";
	readonly label: "live" | "updating" | "paused";
}

export function liveStrip(state: LivePopupState): LiveStrip {
	switch (state.status) {
		case "updating":
			return { dot: "updating", label: "updating" };
		case "paused":
		case "stopped":
		case "closed":
			return { dot: "paused", label: "paused" };
		case "error":
			return { dot: "error", label: "paused" };
		case "consent":
			return { dot: "consent", label: "live" };
		default:
			return { dot: "running", label: "live" };
	}
}

/** Blocks in the list (everything but skip-class). */
export const listedLiveBlocks = (s: LivePopupState): readonly LivePopupBlock[] =>
	s.blocks.filter((b) => b.cls !== "skip");
/** Blocks in the "N blocks skipped" line (GLIM-82). */
export const skippedLiveBlocks = (s: LivePopupState): readonly LivePopupBlock[] =>
	s.blocks.filter((b) => b.cls === "skip");

/** The L7 empty row shows: no text for 5 s while capturing. */
export const liveShowsEmpty = (s: LivePopupState): boolean =>
	s.status === "empty" && listedLiveBlocks(s).length === 0 && skippedLiveBlocks(s).length === 0;

/** One line per state for the harness and logs. Screen text only as given (scripted OCR). */
export function livePopupSummary(s: LivePopupState): string {
	const strip = liveStrip(s);
	const flags = [
		s.stale ? "stale" : "",
		s.private ? "private" : "",
		s.providers.cloud ? `cloud:${s.providers.cloud.id}` : "",
		s.packs.length > 0 ? `packs:${s.packs.map((p) => `${p.lang}=${p.state}`).join(",")}` : "",
	]
		.filter(Boolean)
		.join(" ");
	const blocks = s.blocks
		.map((b) => {
			const mark = b.changeId !== null && b.changeId === s.changeSeq ? "*" : " ";
			const shown = b.holding
				? `hold ${JSON.stringify(b.translation)}`
				: b.pending
					? `pending ${JSON.stringify(b.partial ?? b.source)}`
					: b.cls === "translate"
						? JSON.stringify(b.failed ? `!${b.source}` : b.translation)
						: `${b.cls} ${JSON.stringify(b.source)}`;
			return `${mark}${b.id} ${shown}`;
		})
		.join(" | ");
	const head = `${strip.dot}/${s.status}${s.reason ? `(${s.reason})` : ""}${flags ? ` ${flags}` : ""} set ${s.changeSeq}`;
	return liveShowsEmpty(s) ? `${head} [empty]` : `${head} [${blocks}]`;
}
