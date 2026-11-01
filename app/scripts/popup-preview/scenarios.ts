// Snip popup states for the preview and the committed screenshots (snip-popup.md §4 IDs).
// Every state is built the way the app builds it: scripted pipeline events folded through
// the real `reduceSnip`, so a screenshot shows what main would push, not a hand-made prop.
import {
	type BlockClass,
	initialSnipState,
	languageCode,
	type PipelineEvent,
	type PipelineResult,
	type PopupSide,
	type Provenance,
	type RecognisedBlock,
	rect,
	reduceSnip,
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
		name: "s15-private",
		caption: "S15 Private on",
		state: () => run([["Su pedido ha sido enviado.", "es", "translate", "Your order has shipped."]], { priv: true }),
	},
];

export function scenarioMessage(s: Scenario, reducedMotion = true): SnipStateMessage {
	return {
		requestId: RUN,
		layout: { side: s.side ?? "below", width: s.width ?? 360, maxHeight: s.maxHeight ?? 511 },
		state: s.state(),
		reducedMotion,
	};
}

export const scenarioNames = (): string[] => SCENARIOS.map((s) => s.name);
