// live-popup.md §5: diffLiveBlocks (IoU and text matching, silent neutral / skip updates,
// stable order, removal, first fill without marks).
import { describe, expect, test } from "bun:test";
import { type BlockClass, diffLiveBlocks, type LiveBlock, type LiveBlockInput, rect } from "@glimpse/core";

const input = (source: string, y: number, cls: BlockClass = "translate", x = 0): LiveBlockInput => ({
	cls,
	lang: null,
	direction: "ltr",
	box: rect(x, y, 200, 20),
	source,
	translation: null,
	failed: false,
	waitingForPack: false,
});

function ids() {
	let n = 0;
	return () => `L${++n}`;
}

function fill(sources: readonly [string, number, BlockClass?][]): {
	blocks: readonly LiveBlock[];
	newId: () => string;
} {
	const newId = ids();
	const d = diffLiveBlocks(
		[],
		sources.map(([s, y, c]) => input(s, y, c)),
		{ newId },
	);
	return { blocks: d.blocks, newId };
}

describe("diffLiveBlocks", () => {
	test("first fill: every block upserted, nothing marked", () => {
		const d = diffLiveBlocks([], [input("Hello", 0), input("World", 30)], { newId: ids() });
		expect(d.upserts.map((u) => [u.id, u.changed])).toEqual([
			["L1", false],
			["L2", false],
		]);
		expect(d.changeSet).toEqual([]);
		expect(d.order).toEqual(["L1", "L2"]);
	});

	test("same text in the same place: no upsert, keeps its id and translation (box jitter ignored)", () => {
		const { blocks, newId } = fill([
			["Hello", 0],
			["World", 30],
		]);
		const shown = blocks.map((b) => ({ ...b, translation: `[${b.source}]` }));
		const d = diffLiveBlocks(shown, [input("Hello", 2), input("World", 31)], { newId });
		expect(d.upserts).toEqual([]);
		expect(d.removes).toEqual([]);
		expect(d.changeSet).toEqual([]);
		expect(d.blocks.map((b) => [b.id, b.translation, b.box.y])).toEqual([
			["L1", "[Hello]", 2],
			["L2", "[World]", 31],
		]);
	});

	test("changed text in the same place: upsert + mark, same id, translation pending", () => {
		const { blocks, newId } = fill([["Hello", 0]]);
		const d = diffLiveBlocks(blocks, [input("Goodbye", 0)], { newId });
		expect(d.upserts).toMatchObject([{ id: "L1", source: "Goodbye", translation: null, changed: true }]);
		expect(d.changeSet).toEqual(["L1"]);
	});

	test("neutral and skipped blocks update silently", () => {
		const { blocks, newId } = fill([
			["HP 100", 0, "neutral"],
			["Bonjour", 30, "skip"],
		]);
		const d = diffLiveBlocks(
			blocks,
			[input("HP 90", 0, "neutral"), input("Salut", 30, "skip"), input("42", 60, "neutral")],
			{
				newId,
			},
		);
		expect(d.upserts.map((u) => [u.source, u.changed])).toEqual([
			["HP 90", false],
			["Salut", false],
			["42", false],
		]);
		expect(d.changeSet).toEqual([]);
	});

	test("a class flip with the same text is an upsert without a mark", () => {
		const { blocks, newId } = fill([["Hola", 0]]);
		const d = diffLiveBlocks(blocks, [input("Hola", 0, "skip")], { newId });
		expect(d.upserts).toMatchObject([{ id: "L1", cls: "skip", changed: false }]);
		expect(d.changeSet).toEqual([]);
	});

	test("scrolling chat: same text at a new place keeps its id; the new line is added and marked", () => {
		const { blocks, newId } = fill([
			["one", 0],
			["two", 30],
			["three", 60],
		]);
		// Everything moved up one line; "four" arrived at the bottom; "one" scrolled away.
		const d = diffLiveBlocks(blocks, [input("two", 0), input("three", 30), input("four", 60)], { newId });
		expect(d.removes).toEqual(["L1"]);
		expect(d.upserts.map((u) => [u.id, u.source, u.changed])).toEqual([["L4", "four", true]]);
		expect(d.order).toEqual(["L2", "L3", "L4"]);
		expect(d.changeSet).toEqual(["L4"]);
	});

	test("new blocks go in at their reading-order position; survivors never swap", () => {
		const { blocks, newId } = fill([
			["top", 0],
			["bottom", 100],
		]);
		const d = diffLiveBlocks(blocks, [input("top", 0), input("middle", 50), input("bottom", 100)], { newId });
		expect(d.order).toEqual(["L1", "L3", "L2"]);
		expect(d.upserts).toMatchObject([{ id: "L3", order: 1, changed: true }]);
		// Even if OCR now reads them in the other order, the survivors keep theirs.
		const swapped = diffLiveBlocks(d.blocks, [input("bottom", 100), input("top", 0)], { newId });
		expect(swapped.order).toEqual(["L1", "L2"]);
		expect(swapped.removes).toEqual(["L3"]);
	});

	test("ids maps every input to its stable id", () => {
		const { blocks, newId } = fill([["a", 0]]);
		const d = diffLiveBlocks(blocks, [input("b", 40), input("a", 0)], { newId });
		expect(d.ids).toEqual(["L2", "L1"]);
	});
});
