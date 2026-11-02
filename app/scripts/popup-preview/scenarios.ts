// Snip popup states for the preview and the committed screenshots (snip-popup.md §4 IDs).
// Every state is built the way the app builds it: scripted pipeline events folded through
// the real `reduceSnip`, so a screenshot shows what main would push, not a hand-made prop.
import {
	type BlockClass,
	initialSnipState,
	languageCode,
	type PackRow,
	type PipelineErrorKind,
	type PipelineEvent,
	type PipelineResult,
	type PopupSide,
	type Provenance,
	type RecognisedBlock,
	rect,
	reduceSnip,
	type SegmentFailureKind,
	type SnipAction,
	type SnipPopupState,
} from "@glimpse/core";
import type { SnipStateMessage } from "../../src/shared/popup-rpc.ts";

const L = languageCode;
const RUN = "preview";
const RTL = new Set(["ar", "he", "fa", "ur"]);

type B = readonly [text: string, lang: string | null, cls: BlockClass, translation?: string];

function blocks(list: readonly B[]): RecognisedBlock[] {
	return list.map(
		([text, lang, cls], order): RecognisedBlock => ({
			id: `b${order + 1}`,
			order,
			box: rect(0, order * 30, 300 - order * 40, 22),
			text,
			confidence: 0.95,
			language: lang ? { kind: "language", lang: L(lang), confidence: 1 } : { kind: "neutral" },
			lang: lang ? L(lang) : null,
			cls,
			direction: lang && RTL.has(lang) ? "rtl" : "ltr",
			waitingForPack: false,
		}),
	);
}

const LOCAL: Provenance = {
	id: "bergamot",
	kind: "local",
	name: "On-device translation",
	providerId: "bergamot",
	modelRevision: "1",
	optionsHash: "x",
};
const GOOGLE: Provenance = {
	id: "cloud:google-translate-v2",
	kind: "cloud",
	name: "Google Cloud Translation",
	providerId: "cloud:google-translate-v2",
	modelRevision: "v2",
	optionsHash: "x",
};

function started(target = "en", priv = false, cloud = false): PipelineEvent {
	return {
		type: "started",
		runId: RUN,
		mode: "snip",
		target: L(target),
		private: priv,
		ocr: { id: "paddleocr", kind: "local", name: "PaddleOCR" },
		translation: cloud ? GOOGLE : LOCAL,
	};
}

function translationEvent(id: string, text: string, from: string, to: string, final = true): PipelineEvent {
	return {
		type: "translation",
		runId: RUN,
		translation: { blockId: id, text, final, failure: null, from: L(from), to: L(to), via: [], provider: LOCAL },
	};
}

function done(rs: RecognisedBlock[], over: Partial<PipelineResult> = {}): PipelineEvent {
	return {
		type: "done",
		runId: RUN,
		result: {
			runId: RUN,
			mode: "snip",
			target: L("en"),
			blocks: rs,
			translations: {},
			packs: [],
			done: 0,
			total: 0,
			error: null,
			ocr: null,
			translators: [LOCAL],
			cloud: false,
			private: false,
			timings: { ocrMs: 0, translateMs: 0, totalMs: 0 },
			...over,
		},
	};
}

/** Recognise `list`, translate every translate-class block that has a translation, finish. */
function run(
	list: readonly B[],
	o: { target?: string; finish?: boolean; upTo?: number; priv?: boolean; cloud?: boolean; extra?: SnipAction[] } = {},
): SnipPopupState {
	const target = o.target ?? "en";
	const rs = blocks(list);
	const events: PipelineEvent[] = [started(target, o.priv, o.cloud), { type: "recognised", runId: RUN, blocks: rs }];
	let n = 0;
	list.forEach(([, lang, cls, tr], i) => {
		if (cls !== "translate" || tr === undefined || !lang) return;
		if (o.upTo !== undefined && n >= o.upTo) return;
		n++;
		events.push(translationEvent(`b${i + 1}`, tr, lang, target));
	});
	const total = list.filter(([, , c]) => c === "translate").length;
	if (total > 0) events.push({ type: "progress", runId: RUN, done: n, total });
	if (o.finish !== false) events.push(done(rs, o.cloud ? { translators: [GOOGLE], cloud: true } : {}));
	let s = initialSnipState(RUN);
	for (const event of events) s = reduceSnip(s, { type: "pipeline", event });
	for (const a of o.extra ?? []) s = reduceSnip(s, a);
	return s;
}

function fold(events: readonly PipelineEvent[], extra: readonly SnipAction[] = []): SnipPopupState {
	let s = initialSnipState(RUN);
	for (const event of events) s = reduceSnip(s, { type: "pipeline", event });
	for (const a of extra) s = reduceSnip(s, a);
	return s;
}

function failed(id: string, kind: SegmentFailureKind, from: string): PipelineEvent {
	return {
		type: "translation",
		runId: RUN,
		translation: {
			blockId: id,
			text: "",
			final: true,
			failure: { kind, error: { code: "internal", message: kind, providerId: "bergamot", retryable: true } },
			from: L(from),
			to: L("en"),
			via: [],
			provider: null,
		},
	};
}

/** A finished run with a whole-run error (E1-E7). */
function errorRun(
	kind: PipelineErrorKind,
	list: readonly B[],
	o: { cloud?: boolean; before?: (rs: RecognisedBlock[]) => PipelineEvent[]; extra?: SnipAction[] } = {},
): SnipPopupState {
	const rs = blocks(list);
	return fold(
		[
			started("en", false, o.cloud),
			...(list.length > 0 ? [{ type: "recognised", runId: RUN, blocks: rs } as const] : []),
			...(o.before?.(rs) ?? []),
			done(rs, { error: { kind, message: kind }, ...(o.cloud ? { translators: [GOOGLE], cloud: true } : {}) }),
		],
		o.extra,
	);
}

const GREEK: readonly B[] = [
	["Προσφορά ελεύθερης αποστολής", "el", "translate"],
	["Παραλαβή από το κατάστημα", "el", "translate"],
];

function packRow(
	lang: string,
	ids: string[],
	state: PackRow["state"] = "missing",
	progress: number | null = null,
): PackRow {
	return { lang: L(lang), state, resourceIds: [`bergamot-${lang}en`], bytes: 31_000_000, progress, segmentIds: ids };
}

/** The SMaLL-100 long-tail model's row (GLIM-100/138): one 618 MB download for ~100 languages. */
function longTailRow(lang: string, ids: string[]): PackRow {
	return {
		lang: L(lang),
		state: "missing",
		resourceIds: ["small100"],
		bytes: 618_000_000,
		progress: null,
		segmentIds: ids,
		kind: "long-tail-model",
	};
}

const SWAHILI_PARTIAL: readonly B[] = [
	["Envío gratis en pedidos de más de 50 euros", "es", "translate"],
	["Usafirishaji bure kwa oda zote", "sw", "translate"],
	["Oferta válida hasta agotar existencias", "es", "translate"],
];

function longTailPartial(): SnipPopupState {
	const rs = blocks(SWAHILI_PARTIAL);
	return fold([
		started(),
		{ type: "recognised", runId: RUN, blocks: rs.map((b) => (b.lang === "sw" ? { ...b, waitingForPack: true } : b)) },
		{ type: "packs", runId: RUN, rows: [longTailRow("sw", ["b2"])] },
		translationEvent("b1", "Free shipping on orders over 50 euros", "es", "en"),
		translationEvent("b3", "Offer valid while stocks last", "es", "en"),
		done(rs),
	]);
}

const MAIN: readonly B[] = [
	["¿Nos vemos a las ocho?", "es", "translate", "See you at eight?"],
	["12:45", null, "neutral"],
	["Traje el libro que me pediste", "es", "translate", "I brought the book you asked for"],
	["Está en la mesa de la cocina", "es", "translate", "It's on the kitchen table"],
	["Увидимся завтра", "ru", "skip"],
	["Danke dir!", "de", "skip"],
];

export interface Scenario {
	readonly name: string;
	readonly caption: string;
	readonly side?: PopupSide;
	readonly width?: number;
	readonly maxHeight?: number;
	readonly state: () => SnipPopupState;
	/** E3 offers "Translate on this device" (GLIM-80). */
	readonly localAvailable?: boolean;
	/** Screenshots click this (a CSS selector) first, for states behind a press (GLIM-138 confirm). */
	readonly click?: string;
}

export const SCENARIOS: readonly Scenario[] = [
	{ name: "s0-opened", caption: "S0 opened, before detection", state: () => initialSnipState(RUN) },
	{
		name: "s1-detected",
		caption: "S1 detected: one bar per box",
		state: () =>
			reduceSnip(reduceSnip(initialSnipState(RUN), { type: "pipeline", event: started() }), {
				type: "pipeline",
				event: {
					type: "detected",
					runId: RUN,
					image: { width: 400, height: 200 },
					boxes: [
						{ id: "1", box: rect(0, 0, 330, 20) },
						{ id: "2", box: rect(0, 30, 60, 20) },
						{ id: "3", box: rect(0, 60, 400, 20) },
						{ id: "4", box: rect(0, 90, 280, 20) },
					],
				},
			}),
	},
	{
		name: "s2-recognised",
		caption: "S2 recognised, pending source",
		state: () => run(MAIN, { upTo: 0, finish: false }),
	},
	{ name: "s3-streaming", caption: "S3 streaming: 1 of 3", state: () => run(MAIN, { upTo: 1, finish: false }) },
	{ name: "s4-done", caption: "S4 done", state: () => run(MAIN) },
	{
		name: "s4-copied",
		caption: "S4 done, copied to the clipboard (2 s)",
		state: () => run(MAIN, { extra: [{ type: "copied", what: "translation", auto: true }] }),
	},
	{
		name: "s7-skipped-expanded",
		caption: "S7 skipped line expanded",
		state: () => run(MAIN, { extra: [{ type: "toggleSkipped", expanded: true }] }),
	},
	{
		name: "s8-mixed-languages",
		caption: "S8 mixed languages: tags, already-in-target",
		state: () =>
			run([
				["Where did you leave it?", "en", "target"],
				["Lo dejé en el estante", "es", "translate", "I left it on the shelf"],
				["Ich glaube, es ist in der Küche.", "de", "translate", "I think it's in the kitchen."],
				["保存に失敗しました。", "ja", "translate", "Saving failed."],
			]),
	},
	{
		name: "s9-rtl-source",
		caption: "S9 Arabic source, English target",
		state: () =>
			run([
				["الاجتماع غداً الساعة 3 PM في المكتب", "ar", "translate", "The meeting is tomorrow at 3 PM in the office"],
				["شكراً جزيلاً", "ar", "translate", "Thank you very much"],
				["09:14", null, "neutral"],
			]),
	},
	{
		name: "s10-rtl-target",
		caption: "S10 Arabic target",
		state: () =>
			run(
				[
					["See you at eight?", "en", "translate", "نراك في الثامنة؟"],
					["It's on the kitchen table", "en", "translate", "إنه على طاولة المطبخ"],
				],
				{ target: "ar" },
			),
	},
	{
		name: "s12-long",
		caption: "S12 very long: list scrolls, footer pinned, divider",
		maxHeight: 300,
		state: () =>
			run(
				Array.from(
					{ length: 8 },
					(_, i): B => [
						`Cláusula ${i + 1}. El inquilino pagará la renta el primer día hábil de cada mes.`,
						"es",
						"translate",
						`Clause ${i + 1}. The tenant shall pay the rent on the first working day of every month by bank transfer.`,
					],
				),
				{ upTo: 5, finish: false },
			),
	},
	{ name: "s13-short", caption: "S13 one word", state: () => run([["Ajustes", "es", "translate", "Settings"]]) },
	{
		name: "s14-cloud",
		caption: "S14 cloud in use",
		state: () => run([["Su pedido ha sido enviado.", "es", "translate", "Your order has shipped."]], { cloud: true }),
	},
	{
		name: "s14-cloud-narrow",
		caption: "S14 cloud, narrow popup: the pill takes its own row with the short name",
		width: 200,
		state: () => run([["Enviado.", "es", "translate", "Shipped."]], { cloud: true }),
	},
	{
		name: "s14-cloud-private",
		caption: "S14 cloud + Private: the pill takes its own row",
		width: 280,
		state: () =>
			run([["Su pedido ha sido enviado.", "es", "translate", "Your order has shipped."]], { cloud: true, priv: true }),
	},
	{
		name: "s15-private",
		caption: "S15 Private on",
		state: () => run([["Su pedido ha sido enviado.", "es", "translate", "Your order has shipped."]], { priv: true }),
	},
];

/** Loading and error states (GLIM-73). */
export const ERROR_SCENARIOS: readonly Scenario[] = [
	{ name: "e1-no-text", caption: "E1 no text found", state: () => errorRun("noText", []) },
	{
		name: "e2-pack-missing",
		caption: "E2 language pack missing",
		state: () =>
			errorRun("packMissing", GREEK, {
				before: () => [{ type: "packs", runId: RUN, rows: [packRow("el", ["b1", "b2"])] }],
			}),
	},
	{
		name: "e2-downloading",
		caption: "E2 downloading the pack",
		state: () =>
			errorRun("packMissing", GREEK, {
				before: () => [{ type: "packs", runId: RUN, rows: [packRow("el", ["b1", "b2"], "downloading", 0.38)] }],
			}),
	},
	{
		name: "e3-offline",
		caption: "E3 offline (cloud provider)",
		state: () =>
			errorRun("offline", [["¿Nos vemos a las ocho?", "es", "translate"]], {
				cloud: true,
				before: () => [failed("b1", "offline", "es")],
			}),
	},
	{
		name: "e3-key",
		caption: "E3 rejected key (cloud provider)",
		state: () =>
			errorRun("providerKey", [["¿Nos vemos a las ocho?", "es", "translate"]], {
				cloud: true,
				before: () => [failed("b1", "providerKey", "es")],
			}),
	},
	{
		name: "e3-quota-local",
		caption: "E3 quota used up, local packs installed: Translate on this device",
		localAvailable: true,
		state: () =>
			errorRun("providerQuota", [["¿Nos vemos a las ocho?", "es", "translate"]], {
				cloud: true,
				before: () => [failed("b1", "providerQuota", "es")],
			}),
	},
	{
		name: "e3-offline-local",
		caption: "E3 offline, local packs installed",
		localAvailable: true,
		state: () =>
			errorRun("offline", [["¿Nos vemos a las ocho?", "es", "translate"]], {
				cloud: true,
				before: () => [failed("b1", "offline", "es")],
			}),
	},
	{ name: "e4-screen-access", caption: "E4 Screen Recording off (macOS)", state: () => errorRun("screenAccess", []) },
	{ name: "e4w-capture-blank", caption: "E4 blank capture", state: () => errorRun("captureBlank", []) },
	{
		name: "e5-nothing-to-translate",
		caption: "E5 every block skipped (expanded)",
		state: () =>
			errorRun("nothingToTranslate", [
				["Увидимся завтра", "ru", "skip"],
				["Danke dir!", "de", "skip"],
				["До встречи", "ru", "skip"],
			]),
	},
	{ name: "e7-ocr-failed", caption: "E7 text recognition failed", state: () => errorRun("ocrFailed", []) },
	{
		name: "e2-long-tail-confirm",
		caption: "E2 the More languages model is missing: Download asks first (GLIM-138)",
		state: () =>
			errorRun("packMissing", [["Usafirishaji bure kwa oda zote", "sw", "translate"]], {
				before: () => [{ type: "packs", runId: RUN, rows: [longTailRow("sw", ["b1"])] }],
			}),
		click: ".snip-error-actions button",
	},
	{
		name: "s17-long-tail-pack-row",
		caption: "S17 pack row for the More languages model (GLIM-138)",
		state: longTailPartial,
	},
	{
		name: "s17-long-tail-confirm",
		caption: "S17 its Download asks before 618 MB (GLIM-138)",
		state: longTailPartial,
		click: "[data-pack-download]",
	},
	{
		name: "s16-partial-pack-row",
		caption: "S16 partial failure + pack row",
		state: () => {
			const list: readonly B[] = [
				["Envío gratis en pedidos de más de 50 euros", "es", "translate"],
				["Προσφορά ελεύθερης αποστολής", "el", "translate"],
				["Oferta válida hasta agotar existencias", "es", "translate"],
			];
			const rs = blocks(list);
			return fold([
				started(),
				{
					type: "recognised",
					runId: RUN,
					blocks: rs.map((b) => (b.lang === "el" ? { ...b, waitingForPack: true } : b)),
				},
				{ type: "packs", runId: RUN, rows: [packRow("el", ["b2"])] },
				translationEvent("b1", "Free shipping on orders over 50 euros", "es", "en"),
				failed("b3", "failed", "es"),
				done(rs),
			]);
		},
	},
];

const RTL_SOURCE: readonly B[] = [
	["الاجتماع غداً الساعة 3 PM في المكتب", "ar", "translate", "The meeting is tomorrow at 3 PM in the office"],
	["شكراً جزيلاً", "ar", "translate", "Thank you very much"],
	["09:14", null, "neutral"],
];

/** Show original (GLIM-74). */
export const ORIGINAL_SCENARIOS: readonly Scenario[] = [
	{
		name: "s5-original-under",
		caption: "S5 show original under translation, mixed languages",
		state: () => ({
			...run([
				["Nos vemos mañana a las tres en la oficina", "es", "translate", "See you tomorrow at three in the office"],
				...RTL_SOURCE.slice(0, 2),
			]),
			showOriginalUnder: true,
		}),
	},
	{
		name: "s6-original-view",
		caption: "S6 original view, RTL source",
		state: () => run(RTL_SOURCE, { extra: [{ type: "toggleOriginal", on: true }] }),
	},
];

export const ALL_SCENARIOS: readonly Scenario[] = [...SCENARIOS, ...ORIGINAL_SCENARIOS, ...ERROR_SCENARIOS];

export function scenarioMessage(s: Scenario, reducedMotion = true): SnipStateMessage {
	return {
		requestId: RUN,
		layout: { side: s.side ?? "below", width: s.width ?? 360, maxHeight: s.maxHeight ?? 511 },
		state: s.state(),
		reducedMotion,
		providerShortName: "Google",
		localAvailable: s.localAvailable ?? false,
	};
}

export const scenarioNames = (): string[] => ALL_SCENARIOS.map((s) => s.name);
