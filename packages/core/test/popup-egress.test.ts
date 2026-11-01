// GLIM-80: the cloud-in-use indicator: badge from provenance, pill copy, footer wrap rules,
// and the badge following "Translate on this device".
import { describe, expect, test } from "bun:test";
import {
	egressCopy,
	footerLayout,
	initialSnipState,
	languageCode,
	type PipelineEvent,
	type PipelineResult,
	type Provenance,
	type RecognisedBlock,
	rect,
	reduceSnip,
	type SnipPopupState,
	type SnipProviderBadge,
} from "../src/index.ts";

const L = languageCode;
const RUN = "run-1";

const prov = (id: string, kind: "local" | "cloud", name: string, remembered = false): Provenance => ({
	id,
	kind,
	name,
	providerId: id,
	modelRevision: "r",
	optionsHash: "h",
	...(remembered ? { remembered: true as const } : {}),
});
const GOOGLE = prov("cloud:google-translate-v2", "cloud", "Google Cloud Translation");
const VISION = prov("cloud:google-vision", "cloud", "Google Cloud Vision");
const BERGAMOT = prov("bergamot", "local", "On-device translation");

const block = (id: string, order: number): RecognisedBlock => ({
	id,
	order,
	box: rect(0, order * 30, 200, 20),
	text: `texto ${id}`,
	confidence: 0.9,
	language: { kind: "language", lang: L("es"), confidence: 1 },
	lang: L("es"),
	cls: "translate",
	direction: "ltr",
	waitingForPack: false,
});

const started = (ocr: Provenance, translation: Provenance): PipelineEvent => ({
	type: "started",
	runId: RUN,
	mode: "snip",
	target: L("en"),
	private: false,
	ocr,
	translation,
});

const result = (over: Partial<PipelineResult>): PipelineResult => ({
	runId: RUN,
	mode: "snip",
	target: L("en"),
	blocks: [],
	translations: {},
	packs: [],
	done: 0,
	total: 0,
	error: null,
	ocr: null,
	translators: [],
	cloud: false,
	private: false,
	timings: { ocrMs: 0, translateMs: 0, totalMs: 1 },
	...over,
});

const fold = (events: readonly PipelineEvent[], start: SnipPopupState = initialSnipState(RUN)) =>
	events.reduce((s, event) => reduceSnip(s, { type: "pipeline", event }), start);

const cloudBadge = (over: Partial<Extract<SnipProviderBadge, { kind: "cloud" }>> = {}) =>
	({
		kind: "cloud",
		name: "Google Cloud Translation",
		id: "cloud:google-translate-v2",
		ocrName: null,
		translatorName: "Google Cloud Translation",
		remembered: false,
		sent: "text",
		segments: 3,
		...over,
	}) as const;

describe("egressCopy (snip-popup.md §12)", () => {
	test("text: full and short label, segment count in the tooltip", () => {
		expect(egressCopy(cloudBadge(), "Google")).toEqual({
			label: "Sent to Google Cloud Translation",
			shortLabel: "Sent to Google",
			tooltip: "Text sent to Google Cloud Translation (3 segments)",
		});
		expect(egressCopy(cloudBadge({ segments: 1 }), null).tooltip).toBe(
			"Text sent to Google Cloud Translation (1 segment)",
		);
		expect(egressCopy(cloudBadge(), null).shortLabel).toBe("Sent to Google Cloud Translation");
	});

	test("image and both", () => {
		const image = cloudBadge({
			name: "Google Cloud Vision",
			ocrName: "Google Cloud Vision",
			translatorName: null,
			sent: "image",
		});
		expect(egressCopy(image, "Google").tooltip).toBe("Image of the selected area sent to Google Cloud Vision");
		const both = cloudBadge({ ocrName: "Google Cloud Vision", sent: "both" });
		expect(egressCopy(both, "Google").tooltip).toBe(
			"Text read by Google Cloud Vision · Translated by Google Cloud Translation",
		);
	});

	test("remembered", () => {
		const c = egressCopy(cloudBadge({ remembered: true }), "Google");
		expect(c.label).toBe("Sent to Google Cloud Translation (remembered)");
		expect(c.shortLabel).toBe("Sent to Google (remembered)");
		expect(c.tooltip).toContain("nothing was sent again");
	});
});

describe("footerLayout (§2.4 cloud footer wrap)", () => {
	test("one row when everything fits", () => {
		expect(footerLayout({ footer: 340, pill: 200, shortPill: 100, rest: 120 })).toEqual({
			ownRow: false,
			short: false,
		});
	});
	test("own row when the row doesn't fit, full name while the pill alone fits", () => {
		expect(footerLayout({ footer: 260, pill: 200, shortPill: 100, rest: 120 })).toEqual({ ownRow: true, short: false });
	});
	test("short name when even the pill alone doesn't fit", () => {
		expect(footerLayout({ footer: 180, pill: 200, shortPill: 100, rest: 120 })).toEqual({ ownRow: true, short: true });
	});
});

describe("the badge (GLIM-80)", () => {
	test("started: names the cloud translator and the cloud OCR provider", () => {
		const s = fold([started(VISION, GOOGLE)]);
		expect(s.provider).toMatchObject({
			kind: "cloud",
			id: "cloud:google-translate-v2",
			name: "Google Cloud Translation",
			ocrName: "Google Cloud Vision",
			translatorName: "Google Cloud Translation",
			sent: "both",
		});
		expect(s.translatorProvider?.name).toBe("Google Cloud Translation");
	});

	test("cloud OCR only: 'image', named by the OCR provider", () => {
		expect(fold([started(VISION, BERGAMOT)]).provider).toMatchObject({
			kind: "cloud",
			name: "Google Cloud Vision",
			sent: "image",
			translatorName: null,
		});
	});

	test("Translate on this device after an E3: the badge goes back to On device", () => {
		const paddle = prov("paddleocr", "local", "PaddleOCR");
		const blocks = [block("a", 0), block("b", 1)];
		let s = fold([
			started(paddle, GOOGLE),
			{ type: "recognised", runId: RUN, blocks },
			{
				type: "done",
				runId: RUN,
				result: result({ ocr: paddle, error: { kind: "providerQuota", message: "quota" } }),
			},
		]);
		expect(s.error).toBe("providerQuota");
		s = reduceSnip(s, { type: "followUp", phase: "start", blockIds: ["a", "b"] });
		for (const id of ["a", "b"]) {
			s = reduceSnip(s, {
				type: "pipeline",
				event: {
					type: "translation",
					runId: RUN,
					translation: {
						blockId: id,
						text: `text ${id}`,
						final: true,
						failure: null,
						from: L("es"),
						to: L("en"),
						via: [],
						provider: BERGAMOT,
					},
				},
			});
		}
		s = reduceSnip(s, { type: "followUp", phase: "end" });
		expect(s.phase).toBe("done");
		expect(s.error).toBeNull();
		expect(s.provider).toEqual({ kind: "local" });
	});

	test("a follow-up through the cloud keeps the pill, with the segment count", () => {
		const paddle = prov("paddleocr", "local", "PaddleOCR");
		let s = fold([
			started(paddle, GOOGLE),
			{ type: "recognised", runId: RUN, blocks: [block("a", 0)] },
			{ type: "done", runId: RUN, result: result({ ocr: paddle, error: { kind: "offline", message: "x" } }) },
		]);
		s = reduceSnip(s, { type: "followUp", phase: "start", blockIds: ["a"] });
		s = reduceSnip(s, {
			type: "pipeline",
			event: {
				type: "translation",
				runId: RUN,
				translation: {
					blockId: "a",
					text: "t",
					final: true,
					failure: null,
					from: L("es"),
					to: L("en"),
					via: [],
					provider: GOOGLE,
				},
			},
		});
		s = reduceSnip(s, { type: "followUp", phase: "end" });
		expect(s.provider).toMatchObject({ kind: "cloud", name: "Google Cloud Translation", segments: 1, sent: "text" });
	});
});
