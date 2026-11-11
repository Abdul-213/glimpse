// Live popup states for the preview and the committed screenshots (live-popup.md §4 IDs).
// Every state is built the way the app builds it: scripted Live session events folded through
// the real `reduceLivePopup`, so a screenshot shows what main would push.
import {
	type BlockClass,
	type InstallState,
	initialLivePopupState,
	type LiveBlockUpdate,
	type LivePopupAction,
	type LivePopupState,
	type LiveSessionEvent,
	languageCode,
	type PopupSide,
	type ProviderRef,
	type Rect,
	rect,
	reduceLivePopup,
} from "@glimpse/core";
import type { LiveStateMessage } from "../../src/shared/live-rpc.ts";

const S = "preview";
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const GOOGLE: ProviderRef = { id: "cloud:google-translate-v2", kind: "cloud", name: "Google Cloud Translation" };
const VISION: ProviderRef = { id: "cloud:google-vision", kind: "cloud", name: "Google Cloud Vision" };

type B = readonly [id: string, source: string, translation: string | null, cls?: BlockClass, lang?: string];

const up = (b: B, order: number, changed = false): LiveBlockUpdate => ({
	id: b[0],
	order,
	cls: b[3] ?? "translate",
	lang: b[4] === undefined ? languageCode("es") : b[4] === "" ? null : languageCode(b[4]),
	direction: "ltr",
	box: rect(0, order * 24, 300, 22),
	source: b[1],
	translation: b[2],
	failed: false,
	waitingForPack: false,
	changed,
});

const opened = (cloud: ProviderRef | null = null, priv = false): LiveSessionEvent => ({
	type: "opened",
	sessionId: S,
	region: rect(0, 0, 800, 120),
	providers: { cloud, localOnly: false },
	private: priv,
});
const status = (
	s: Extract<LiveSessionEvent, { type: "status" }>["status"],
	over: Partial<Extract<LiveSessionEvent, { type: "status" }>> = {},
): LiveSessionEvent => ({
	type: "status",
	sessionId: S,
	status: s,
	reason: null,
	error: null,
	stale: s === "paused" || s === "error",
	capturedAt: NOW - 4 * 60_000,
	at: NOW,
	...over,
});
let seq = 0;
const frame = (blocks: readonly B[], changeSet: readonly string[] = [], changed: readonly string[] = changeSet) => {
	seq++;
	const ev: LiveSessionEvent = {
		type: "frame",
		sessionId: S,
		frameSeq: seq,
		upserts: blocks.map((b, i) => up(b, i, changed.includes(b[0]))),
		removes: [],
		order: blocks.map((b) => b[0]),
		changeSet,
		capturedAt: NOW - 4 * 60_000,
		reused: false,
		region: rect(0, 0, 800, 120),
		image: { width: 1600, height: 240 },
	};
	return ev;
};
const tr = (id: string, text: string): LiveSessionEvent => ({
	type: "translation",
	sessionId: S,
	frameSeq: seq,
	id,
	text,
	final: true,
	failed: false,
});

const DOOR: B = ["L1", "La puerta del norte está cerrada.", "The north door is locked."];
const GUARD: B = ["L2", "Habla primero con el guardia.", "Talk to the guard first."];
const KEY: B = ["L2", "Busca la llave en la torre.", "Look for the key in the tower."];

/** The first fill, then a changed second line: the main path. */
const running = (cloud: ProviderRef | null = null, priv = false): LiveSessionEvent[] => {
	seq = 0;
	return [opened(cloud, priv), status("starting"), frame([DOOR, GUARD]), status("live")];
};
const changed = (): LiveSessionEvent[] => [...running(), frame([DOOR, KEY], ["L2"], ["L2"]), tr("L2", KEY[2] ?? "")];

// GLIM-154: the manga fixture (docs/samples/comic-ja.png) pinned whole at (40, 40). The
// bubbles are core groupLines' blocks for it in manga reading order, as Snip's GLIM-152 shots.
const COMIC_REGION = rect(40, 40, 640, 720);
const COMIC: readonly (readonly [string, Rect, string, string])[] = [
	[
		"c1",
		rect(448, 53, 110, 204),
		"ちょっと待って 今の音 聞こえた?",
		"Wait a second. Did you hear that sound just now?",
	],
	["c2", rect(169, 110, 111, 150), "何も 聞こえない けど", "I can't hear anything, though."],
	["c3", rect(48, 378, 125, 31), "その夜、森で", "That night, in the forest"],
	["c4", rect(442, 436, 78, 158), "じゃあ あれは何？", "Then what was that?"],
	["c5", rect(147, 471, 73, 150), "きっと 風の音だよ", "It's the wind, I'm sure."],
];

export interface LiveScenario {
	readonly name: string;
	readonly note: string;
	readonly width: number;
	readonly side?: PopupSide;
	readonly maxHeight?: number;
	readonly events: () => readonly (LiveSessionEvent | LivePopupAction)[];
	readonly focused?: boolean;
	/** Screenshots click this (a CSS selector) first, for states behind a press (GLIM-138 confirm). */
	readonly click?: string;
	/** GLIM-151: moved away from the region (Dock shows) / not kept on top. */
	readonly moved?: boolean;
	readonly pinned?: boolean;
	/**
	 * GLIM-154: draw the pinned region too (a comic page with the frame's ticks, badges and
	 * cards, as the native frame paints them), the popup docked at its inline-end side.
	 */
	readonly scene?: { readonly region: Rect };
	/** GLIM-154: the frame can't draw marks out of capture (no numbers, no overlay toggle). */
	readonly noMarks?: boolean;
	/** GLIM-157: Settings › Live › Update is "Only when I refresh". */
	readonly manual?: boolean;
}

export const LIVE_SCENARIOS: readonly LiveScenario[] = [
	{
		name: "l0-first-capture",
		note: "Pinned, first capture: source pending, no marks",
		width: 400,
		events: () => {
			seq = 0;
			return [
				opened(),
				status("starting"),
				frame([
					["L1", DOOR[1], null],
					["L2", GUARD[1], null],
				]),
			];
		},
	},
	{
		name: "l1-running",
		note: "Running, local, wide strip",
		width: 400,
		events: () => [...running(), frame([DOOR, KEY], ["L2"]), tr("L2", KEY[2] ?? "")],
	},
	{ name: "l4-changed", note: "Changed block: resting tint + mark", width: 400, events: changed },
	{
		name: "l4-holding",
		note: "Changed block within 600 ms: old translation held, no mark yet",
		width: 400,
		events: () => [...running(), frame([DOOR, [KEY[0], KEY[1], null]], ["L2"])],
	},
	{
		name: "l4-pending-source",
		note: "Hold ran out: new source in source style, marked",
		width: 400,
		events: () => [
			...running(),
			frame([DOOR, [KEY[0], KEY[1], null]], ["L2"]),
			{ type: "holdExpired", id: "L2", frameSeq: seq },
		],
	},
	{ name: "l3-updating", note: "Processing over 1 s", width: 400, events: () => [...running(), status("updating")] },
	{
		name: "l5-paused",
		note: "Paused, stale: hollow dot, dimmed text, age",
		width: 400,
		events: () => [...changed(), status("paused", { reason: "user" })],
	},
	{
		name: "l7-empty",
		note: "No text for 5 s",
		width: 400,
		events: () => [...running(), { ...frame([]), removes: ["L1", "L2"] } as LiveSessionEvent, status("empty")],
	},
	{
		name: "l8-private-regular",
		note: "Private on, regular width (320)",
		width: 320,
		events: () => [...running(null, true)],
	},
	{
		name: "l9-cloud",
		note: "Cloud in use: the egress row for the whole session",
		width: 400,
		events: () => [...running(GOOGLE), frame([DOOR, KEY], ["L2"]), tr("L2", KEY[2] ?? "")],
	},
	{
		name: "l10-consent",
		note: "First cloud Live session: asks before anything is captured",
		width: 400,
		focused: true,
		events: () => [
			opened(GOOGLE),
			{ type: "consent", sessionId: S, providers: [GOOGLE], canRemember: true, reason: "cloud-translation" },
		],
	},
	{
		name: "l10-consent-cloud-ocr",
		note: "Cloud OCR (asked every session): Use on-device reads with the local OCR instead (GLIM-122)",
		width: 400,
		focused: true,
		events: () => [
			opened(VISION),
			{
				type: "consent",
				sessionId: S,
				providers: [VISION],
				canRemember: false,
				reason: "cloud-ocr",
				localAvailable: true,
			},
		],
	},
	{
		name: "l16-ocr-stopped",
		note: "Error, paused: heading, body, recovery first",
		width: 400,
		events: () => [...changed(), status("error", { error: { kind: "ocrFailed", message: "engine exited" } })],
	},
	{
		name: "l-spend-cap",
		note: "Spend guard (GLIM-120): cloud use paused at the free tier",
		width: 400,
		events: () => [
			...changed(),
			status("error", { error: { kind: "spendCap", message: "paused by the monthly spend guard" } }),
		],
	},
	{
		name: "l-gone",
		note: "Area no longer on a screen",
		width: 400,
		events: () => [...changed(), status("error", { error: { kind: "areaGone", message: "display removed" } })],
	},
	{
		name: "l17-locked",
		note: "Auto-paused while the screen was locked",
		width: 400,
		events: () => [...changed(), status("paused", { reason: "locked" })],
	},
	{
		name: "l21-compact",
		note: 'Compact (240): icon-only local indicator, no " · Private"',
		width: 240,
		events: () => [
			opened(null, true),
			status("starting"),
			frame([["L1", "¿Continuar?", "Continue?"]]),
			status("paused", { reason: "user", capturedAt: NOW - 10_000 }),
		],
	},
	{
		name: "l20-chat-side",
		note: "Chat pane docked to the side; neutral 21:02 never flashes",
		width: 360,
		side: "inline-end",
		maxHeight: 260,
		events: () => {
			seq = 0;
			const lines: B[] = [
				["C1", "Lucía: ¿vienes esta noche?", "Lucía: are you coming tonight?"],
				["C2", "21:02", null, "neutral", ""],
				["C3", "Pablo: voy de camino", "Pablo: I'm on my way"],
			];
			const added: B = ["C4", "Lucía: trae el libro, por favor", "Lucía: bring the book, please"];
			return [opened(), status("starting"), frame(lines), status("live"), frame([...lines, added], ["C4"])];
		},
	},
	{
		name: "l12-pack-missing",
		note: "A block waits for the German pack: the row at the top, its source shown, the rest translated",
		width: 400,
		events: () => packEvents(null),
	},
	{
		name: "l12-pack-downloading",
		note: "Downloading the pack while the session keeps running",
		width: 400,
		events: () => packEvents({ status: "downloading", receivedBytes: 12_400_000, totalBytes: 38_600_000 }),
	},
	{
		name: "l12-long-tail-confirm",
		note: "A Swahili block needs the More languages model: Download asks before 618 MB (GLIM-138)",
		width: 400,
		events: () => packEvents(null, "long-tail"),
		click: "[data-pack-download]",
	},
	{
		name: "l11-skipped",
		note: "Skipped blocks (outside the source subset): one quiet line, never translated",
		width: 400,
		events: () => skippedEvents(false),
	},
	{
		name: "l11-skipped-expanded",
		note: "Expanded: the original text of the skipped blocks, with their language",
		width: 400,
		events: () => skippedEvents(true),
	},
	{
		name: "l22-moved",
		note: "Dragged away from the region (GLIM-151): Dock appears; it stays put for the session",
		width: 400,
		moved: true,
		events: () => [...running(), frame([DOOR, KEY], ["L2"]), tr("L2", KEY[2] ?? "")],
	},
	{
		name: "l23-unpinned",
		note: "Pin off (GLIM-151): a normal window other apps can cover; the pin shows struck through",
		width: 400,
		pinned: false,
		events: () => [...running(), frame([DOOR, KEY], ["L2"]), tr("L2", KEY[2] ?? "")],
	},
	{
		name: "l24-moved-compact",
		note: "Moved, compact strip (240): Dock and Pin still fit",
		width: 240,
		moved: true,
		events: () => [...running(), frame([["L1", "¿Continuar?", "Continue?"]])],
	},
	{
		name: "l27-manual",
		note: "GLIM-157: Update only when I refresh: the toggle pressed, Refresh next to it, the quiet line says why",
		width: 400,
		manual: true,
		events: () => [...running(), frame([DOOR, KEY], ["L2"]), tr("L2", KEY[2] ?? "")],
	},
	{
		name: "l25-comic-markers",
		note: "GLIM-154: a manga page pinned; numbered badges on the bubbles, the same numbers in the popup; bubble 3 clicked on screen",
		width: 320,
		side: "inline-end",
		maxHeight: 720,
		scene: { region: COMIC_REGION },
		events: () => comicEvents(false),
	},
	{
		name: "l26-comic-overlay",
		note: "GLIM-154: overlay mode: each translation painted over its bubble; bubble 2 changed in the latest update",
		width: 320,
		side: "inline-end",
		maxHeight: 720,
		scene: { region: COMIC_REGION },
		events: () => comicEvents(true),
	},
];

function comicEvents(overlay: boolean): (LiveSessionEvent | LivePopupAction)[] {
	seq = 0;
	const comicFrame = (changeSet: readonly string[]): LiveSessionEvent => {
		seq++;
		return {
			type: "frame",
			sessionId: S,
			frameSeq: seq,
			upserts: COMIC.map(([id, box, source, translation], i) => ({
				id,
				order: i,
				cls: "translate",
				lang: languageCode("ja"),
				direction: "ltr",
				box,
				source,
				translation,
				failed: false,
				waitingForPack: false,
				changed: changeSet.includes(id),
			})),
			removes: [],
			order: COMIC.map(([id]) => id),
			changeSet,
			capturedAt: NOW,
			reused: false,
			region: COMIC_REGION,
			image: { width: COMIC_REGION.width, height: COMIC_REGION.height },
		};
	};
	const open: LiveSessionEvent = {
		type: "opened",
		sessionId: S,
		region: COMIC_REGION,
		providers: { cloud: null, localOnly: false },
		private: false,
	};
	return overlay
		? [
				open,
				status("starting"),
				comicFrame([]),
				status("live"),
				{ type: "toggleOverlay", on: true },
				comicFrame(["c2"]),
			]
		: [open, status("starting"), comicFrame([]), status("live"), { type: "select", id: "c3" }];
}

function skippedEvents(expanded: boolean): (LiveSessionEvent | LivePopupAction)[] {
	seq = 0;
	const lines: B[] = [
		DOOR,
		["K1", "Oma: Bis morgen!", null, "skip", "de"],
		["K2", "Opa: Gute Nacht.", null, "skip", "de"],
	];
	return [opened(), status("starting"), frame(lines), status("live"), { type: "skipped", expanded }];
}

function packEvents(
	download: InstallState | null,
	kind: "pack" | "long-tail" = "pack",
): (LiveSessionEvent | LivePopupAction)[] {
	seq = 0;
	const longTail = kind === "long-tail";
	const de = languageCode(longTail ? "sw" : "de");
	const waiting: LiveBlockUpdate = {
		...up(
			longTail
				? ["P1", "Zungumza na mlinzi kwanza.", null, "translate", "sw"]
				: ["P1", "Sprich zuerst mit der Wache.", null, "translate", "de"],
			1,
		),
		waitingForPack: true,
	};
	const f = frame([DOOR]);
	const withPack: LiveSessionEvent =
		f.type === "frame" ? { ...f, upserts: [...f.upserts, waiting], order: ["L1", "P1"] } : f;
	const out: (LiveSessionEvent | LivePopupAction)[] = [
		opened(),
		status("starting"),
		withPack,
		status("live"),
		{
			type: "packs",
			sessionId: S,
			frameSeq: seq,
			rows: [
				longTail
					? {
							lang: de,
							state: "missing",
							resourceIds: ["small100"],
							bytes: 618_000_000,
							progress: null,
							segmentIds: ["P1"],
							kind: "long-tail-model",
						}
					: {
							lang: de,
							state: "missing",
							resourceIds: ["bergamot-deen"],
							bytes: 38_600_000,
							progress: null,
							segmentIds: ["P1"],
						},
			],
		},
	];
	if (download) out.push({ type: "packInstall", lang: de, states: [download] });
	return out;
}

export function liveScenarioState(s: LiveScenario): LivePopupState {
	let state = initialLivePopupState;
	for (const e of s.events()) {
		const own = [
			"session",
			"holdExpired",
			"private",
			"skipped",
			"packInstall",
			"toggleOverlay",
			"select",
			"screenHover",
		].includes(e.type);
		state = reduceLivePopup(state, own ? (e as LivePopupAction) : { type: "session", event: e as LiveSessionEvent });
	}
	return state;
}

export function liveScenarioMessage(s: LiveScenario): LiveStateMessage {
	return {
		sessionId: S,
		layout: {
			side: s.side ?? "above",
			width: s.width,
			maxHeight: s.maxHeight ?? 360,
			moved: s.moved ?? false,
			pinned: s.pinned ?? true,
		},
		state: liveScenarioState(s),
		reducedMotion: true,
		now: NOW,
		focused: s.focused ?? false,
		// GLIM-154: on hardware the frame draws marks (2x displays here, as the shots).
		...(s.noMarks ? {} : { marks: { scale: 2, target: "en" } }),
		// GLIM-157: the app always offers the Update toggle.
		updateToggle: true,
		...(s.manual ? { update: "manual" as const } : {}),
	};
}
