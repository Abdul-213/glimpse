// GLIM-152: numbered markers, overlay text fitting, results-layer hit testing and the popup
// state for overlay mode and picks from the screen.
import { describe, expect, test } from "bun:test";
import {
	badgeAnchor,
	badgeLabel,
	blockNumbers,
	fitText,
	hitResultsBox,
	initialSnipState,
	languageCode,
	overlayCards,
	type PipelineEvent,
	type RecognisedBlock,
	rect,
	reduceSnip,
	resultsBoxes,
	type SnipPopupState,
	snipStatus,
	textAtoms,
	wrapText,
} from "../src/index.ts";

/** Fake measure: every character is 0.5 em wide (CJK 1 em). */
const measure = (s: string, px: number) => [...s].reduce((w, c) => w + (/[　-鿿]/.test(c) ? px : px * 0.5), 0);

describe("blockNumbers", () => {
	test("every boxed block in reading order, neutral blocks skipped, skipped blocks numbered", () => {
		const n = blockNumbers([
			{ id: "a", cls: "translate" },
			{ id: "b", cls: "neutral" },
			{ id: "c", cls: "skip" },
			{ id: "d", cls: "target" },
		]);
		expect([...n]).toEqual([
			["a", 1],
			["c", 2],
			["d", 3],
		]);
	});

	test("labels use the locale's digits", () => {
		expect(badgeLabel(12, "en")).toBe("12");
		expect(badgeLabel(12, "ar-EG")).toBe("١٢");
		expect(badgeLabel(1234, "en")).toBe("1234");
	});
});

describe("fitText", () => {
	test("text that fits at the largest size keeps it", () => {
		const f = fitText("Hi there", { width: 200, height: 40 }, measure);
		expect(f.px).toBe(15);
		expect(f.lines).toEqual(["Hi there"]);
		expect(f.grew).toBe(false);
		expect(f.height).toBe(40);
		expect(f.width).toBe(200);
		expect(f.offsetX).toBe(0);
	});

	test("shrinks to the largest size that fits the box", () => {
		const f = fitText("Wait, did you hear that noise?", { width: 120, height: 60 }, measure);
		expect(f.px).toBeLessThan(15);
		expect(f.px).toBeGreaterThanOrEqual(11);
		expect(f.height).toBe(60);
		expect(f.lines.length * f.linePx + 8).toBeLessThanOrEqual(60);
		// One step larger would not have fitted.
		const bigger = wrapText("Wait, did you hear that noise?", 120 - 12, f.px + 0.5, measure);
		expect(bigger.length * (f.px + 0.5) * 1.5 + 8).toBeGreaterThan(60);
	});

	test("at the floor the card grows downward instead of shrinking further", () => {
		const text = "This is a much longer translation that cannot possibly fit into such a small speech bubble";
		const f = fitText(text, { width: 100, height: 30 }, measure);
		expect(f.px).toBe(11);
		expect(f.grew).toBe(true);
		expect(f.height).toBeGreaterThan(30);
		expect(f.width).toBe(100);
	});

	test("a narrow (vertical) box widens around its centre to fit the longest word", () => {
		const f = fitText("Unbelievable!", { width: 40, height: 200 }, measure);
		expect(f.width).toBeGreaterThan(40);
		expect(f.offsetX).toBe(Math.round((40 - f.width) / 2));
		expect(f.lines).toEqual(["Unbelievable!"]);
	});

	test("a word wider than the widest card breaks between letters", () => {
		const lines = wrapText("Supercalifragilistic", 40, 10, measure);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.join("")).toBe("Supercalifragilistic");
	});

	test("CJK wraps between words without spaces; punctuation stays with its word", () => {
		const atoms = textAtoms("風の音だよ。きっと", "ja");
		expect(atoms.join("")).toBe("風の音だよ。きっと");
		expect(atoms.length).toBeGreaterThan(1);
		expect(atoms.some((a) => a.startsWith("。"))).toBe(false);
		const lines = wrapText("風の音だよ。きっと", 50, 10, measure, "ja");
		expect(lines.length).toBeGreaterThan(1);
	});

	test("Latin atoms carry their trailing space; explicit line breaks are kept", () => {
		expect(textAtoms("Hello, world!")).toEqual(["Hello, ", "world!"]);
		expect(wrapText("One\nTwo", 500, 10, measure)).toEqual(["One", "Two"]);
	});
});

describe("results layer (GLIM-152)", () => {
	const region = rect(100, 100, 400, 300);
	test("badges travel with their boxes", () => {
		const boxes = resultsBoxes(region, 1, [
			{ id: "a", box: rect(0, 0, 50, 20), cls: "translate", badge: 1 },
			{ id: "b", box: rect(0, 40, 50, 20), cls: "neutral" },
		]);
		expect(boxes).toEqual([{ id: "a", rect: rect(100, 100, 50, 20), style: "solid", badge: 1 }]);
	});

	test("badge anchors on the inline-start top corner", () => {
		expect(badgeAnchor(rect(10, 20, 30, 40))).toEqual({ x: 10, y: 20 });
		expect(badgeAnchor(rect(10, 20, 30, 40), "rtl")).toEqual({ x: 40, y: 20 });
	});

	test("hit test: a badge first, else the smallest box, else outside", () => {
		const state = {
			boxes: [
				{ id: "big", rect: rect(0, 0, 200, 200), style: "solid" as const, badge: 1 },
				{ id: "small", rect: rect(50, 50, 40, 20), style: "solid" as const, badge: 2 },
			],
		};
		expect(hitResultsBox(state, { x: 60, y: 60 })).toBe("small");
		expect(hitResultsBox(state, { x: 150, y: 150 })).toBe("big");
		// On the small box's badge (its top-left corner), even though inside the big box.
		expect(hitResultsBox(state, { x: 48, y: 47 })).toBe("small");
		// Just outside the big box, but on its badge.
		expect(hitResultsBox(state, { x: -8, y: -6 })).toBe("big");
		expect(hitResultsBox(state, { x: 300, y: 300 })).toBeNull();
	});

	test("cards: translated translate-class blocks only, in the target's direction", () => {
		const cards = overlayCards(
			[
				{ id: "a", cls: "translate", state: "done", translation: "Hello" },
				{ id: "b", cls: "translate", state: "pending", translation: "Hel" },
				{ id: "c", cls: "target", state: "done", translation: null },
				{ id: "d", cls: "translate", state: "failed", translation: null },
			],
			languageCode("ar"),
		);
		expect(cards).toEqual([{ id: "a", text: "Hello", lang: languageCode("ar"), dir: "rtl" }]);
	});
});

const RUN = "r1";
const block = (id: string, order: number, cls: RecognisedBlock["cls"]): RecognisedBlock => ({
	id,
	order,
	box: rect(0, order * 30, 100, 20),
	text: id,
	confidence: 1,
	language: { kind: "language", lang: languageCode("ja"), confidence: 1 },
	lang: languageCode("ja"),
	cls,
	direction: "ltr",
	waitingForPack: false,
});

function recognised(): SnipPopupState {
	const ev: PipelineEvent = {
		type: "recognised",
		runId: RUN,
		blocks: [block("a", 0, "translate"), block("b", 1, "neutral"), block("c", 2, "skip")],
	};
	return reduceSnip(initialSnipState(RUN), { type: "pipeline", event: ev });
}

describe("snip state: overlay and picks (GLIM-152)", () => {
	test("overlay starts from the setting and toggles; turning it off ends a peek", () => {
		expect(initialSnipState(RUN).overlay).toBe(false);
		expect(initialSnipState(RUN, { overlay: true }).overlay).toBe(true);
		let s = recognised();
		s = reduceSnip(s, { type: "peek", on: true });
		expect(s.peek).toBe(false); // no peeking without the overlay
		s = reduceSnip(s, { type: "toggleOverlay" });
		expect(s.overlay).toBe(true);
		s = reduceSnip(s, { type: "peek", on: true });
		expect(s.peek).toBe(true);
		s = reduceSnip(s, { type: "toggleOverlay", on: false });
		expect(s).toMatchObject({ overlay: false, peek: false });
		expect(reduceSnip(s, { type: "toggleOverlay", on: false })).toBe(s);
	});

	test("a pick names the block with a new seq each time; a skipped pick expands the skipped list", () => {
		let s = recognised();
		s = reduceSnip(s, { type: "select", id: "a" });
		expect(s.selected).toEqual({ id: "a", seq: 1 });
		s = reduceSnip(s, { type: "select", id: "a" });
		expect(s.selected).toEqual({ id: "a", seq: 2 });
		expect(reduceSnip(s, { type: "select", id: "b" })).toBe(s); // neutral: no box, no pick
		expect(reduceSnip(s, { type: "select", id: "zz" })).toBe(s);
		s = reduceSnip(s, { type: "select", id: "c" });
		expect(s.skippedExpanded).toBe(true);
	});

	test("screen hover tracks known blocks only", () => {
		let s = recognised();
		s = reduceSnip(s, { type: "screenHover", id: "a" });
		expect(s.screenLinked).toBe("a");
		s = reduceSnip(s, { type: "screenHover", id: "nope" });
		expect(s.screenLinked).toBeNull();
	});

	test("status: done with the overlay on says how to peek", () => {
		const done = reduceSnip(reduceSnip(recognised(), { type: "toggleOverlay", on: true }), {
			type: "pipeline",
			event: {
				type: "translation",
				runId: RUN,
				translation: {
					blockId: "a",
					text: "A",
					final: true,
					failure: null,
					provider: { id: "bergamot", kind: "local", name: "x" },
				},
			} as PipelineEvent,
		});
		const finished: SnipPopupState = { ...done, phase: "done" };
		expect(snipStatus(finished)).toEqual({ kind: "overlay" });
		expect(snipStatus({ ...finished, overlay: false })).toEqual({ kind: "none" });
	});
});
