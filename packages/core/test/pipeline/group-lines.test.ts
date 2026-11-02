import { describe, expect, test } from "bun:test";
import { BlockIdTracker, groupLines, iou, type OcrBlock, type OcrLine, rect } from "../../src/index.ts";

// Real PP-OCRv5 line output for the provider's layout fixtures
// (packages/providers/test/fixtures/ocr, dumped by packages/providers/scripts/dump-lines.ts).
const fixture = async (name: string): Promise<OcrLine[]> =>
	(await Bun.file(new URL(`../fixtures/ocr-lines/${name}.json`, import.meta.url)).json()) as OcrLine[];

const texts = (blocks: readonly OcrBlock[]) => blocks.map((b) => b.text);
const line = (text: string, x: number, y: number, w: number, h: number, vertical?: boolean): OcrLine => ({
	box: rect(x, y, w, h),
	text,
	confidence: 0.9,
	...(vertical === undefined ? {} : { vertical }),
});

describe("groupLines on real OCR output", () => {
	test("two columns under a full-width heading; short menu items stay separate", async () => {
		const blocks = groupLines(await fixture("columns-en"));
		expect(texts(blocks)).toEqual([
			"Release notes",
			"The new version improves startup\ntime and fixes a crash that could\nhappen when the window was closed.",
			"Known issues: the tray icon may\nnot update until the next restart\non some systems.",
			"Settings",
			"Help",
		]);
		expect(blocks.map((b) => b.id)).toEqual(["b0", "b1", "b2", "b3", "b4"]);
		expect(blocks[1]?.lines).toHaveLength(3);
	});

	test("vertical Japanese: one block, columns right to left", async () => {
		const blocks = groupLines(await fixture("vertical-ja"));
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.writing).toBe("vertical-rl");
		expect(blocks[0]?.text).toBe("吾輩は猫である\n名前はまだ無い\nどこで生れたか");
	});

	test("game dialogue box: the dialogue is one block, the choice row its own", async () => {
		const blocks = groupLines(await fixture("region-game-dark"));
		expect(blocks[0]?.text).toBe("勇者よ、よくぞ来た！\nこの先は危険な森だ。\n準備はできているか？");
		expect(blocks.length).toBeGreaterThanOrEqual(2);
	});

	test("desktop screenshot: menu items, chat names and messages, dialogue box", async () => {
		const blocks = groupLines(await fixture("screen-1920x1080"));
		const t = texts(blocks);
		// Settings menu: each item is its own block.
		for (const item of ["一般", "表示", "ショートカット", "アカウント", "詳細設定"]) expect(t).toContain(item);
		// Chat: speaker names never merge into the previous message.
		expect(t).toContain("你好！今天晚上一起玩游戏吗？");
		expect(t.filter((x) => x === "Anna")).toHaveLength(2);
		// Korean dialogue box: the speaker label alone, the two dialogue lines together.
		expect(t).toContain("상인");
		expect(t.some((x) => x.startsWith("어서 오세요") && x.endsWith("무엇을 도와드릴까요?"))).toBe(true);
		// Windows side by side: the settings window's menu column is read before the chat.
		expect(t.indexOf("詳細設定")).toBeLessThan(t.indexOf("Anna"));
		// The subtitle comes last.
		expect(t.at(-1)).toBe("We have to leave before the storm arrives.");
		expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
	});
});

describe("groupLines rules", () => {
	test("same-row fragments with a small gap join; CJK joins without a space", () => {
		const blocks = groupLines([
			line("Hello", 0, 0, 60, 20),
			line("world", 68, 0, 60, 20),
			line("こんにちは", 0, 100, 100, 20),
			line("世界", 106, 100, 40, 20),
		]);
		expect(texts(blocks)).toEqual(["Hello world", "こんにちは世界"]);
	});

	test("buttons on one row with a wide gap stay separate, left to right", () => {
		const blocks = groupLines([line("Weiter", 300, 0, 70, 20), line("Abbrechen", 0, 0, 100, 20)]);
		expect(texts(blocks)).toEqual(["Abbrechen", "Weiter"]);
	});

	test("different text sizes don't stack (heading over body)", () => {
		const blocks = groupLines([line("A big heading here", 0, 0, 400, 40), line("body text line one", 0, 44, 300, 20)]);
		expect(blocks).toHaveLength(2);
	});

	// GLIM-127: geometry from PP-OCRv5 boxes on the GLIM-64 benchmark corpus.
	test("a heading 1.25x the body size stays out of the paragraph under it", () => {
		const blocks = groupLines([
			line("Save changes to this document?", 21, 21, 318, 30),
			line("If you close it now, the edits you made since the last", 21, 63, 372, 24),
			line("save will be lost and cannot be recovered.", 20, 84, 299, 25),
		]);
		expect(texts(blocks)).toEqual([
			"Save changes to this document?",
			"If you close it now, the edits you made since the last\nsave will be lost and cannot be recovered.",
		]);
	});

	test("a same-size heading over a wider gap stays out too", () => {
		const blocks = groupLines([
			line("Сохранить изменения?", 22, 23, 239, 26),
			line("Если закрыть документ сейчас, все несохранённые", 21, 63, 381, 25),
			line("изменения будут потеряны без возможности восстановления.", 20, 84, 463, 25),
		]);
		expect(blocks).toHaveLength(2);
		expect(blocks[1]?.lines).toHaveLength(2);
	});

	test("long list rows ~2.5 font sizes apart stay separate", () => {
		const blocks = groupLines([
			line("Benachrichtigungen anzeigen", 20, 64, 232, 25),
			line("Beim Start automatisch öffnen", 21, 107, 236, 22),
			line("Sprache und Region", 19, 148, 159, 26),
			line("Tastenkürzel", 20, 189, 102, 26),
		]);
		expect(texts(blocks)).toEqual([
			"Benachrichtigungen anzeigen",
			"Beim Start automatisch öffnen",
			"Sprache und Region",
			"Tastenkürzel",
		]);
		// A short last item with a tall box (no descenders above, Cyrillic Д below).
		expect(groupLines([line("Последни документи", 20, 98, 172, 25), line("Изход", 17, 136, 61, 29)])).toHaveLength(2);
	});

	test("loosely leaded paragraph lines, a last line without descenders, still stack", () => {
		const blocks = groupLines([
			line("Do you want to install the update now?", 14, 46, 406, 29),
			line("Your session will expire in 5 minutes.", 13, 83, 383, 29),
			line("Click Continue to keep working.", 14, 120, 329, 28),
			line("Error 404: file not found", 14, 158, 250, 24),
		]);
		expect(blocks).toHaveLength(1);
	});

	test("a paragraph in one script doesn't wrap into a line in another", () => {
		const blocks = groupLines([
			line("Настройки будут применены после перезапуска.", 35, 77, 387, 28),
			line("Settings apply after a restart.", 34, 114, 228, 27),
		]);
		expect(blocks).toHaveLength(2);
	});

	test("CJK paragraphs keep their wider leading", () => {
		const blocks = groupLines([
			line("您的账户已在另一台设备上登录。如果这不是您本人", 24, 28, 436, 22),
			line("的操作，请立即修改密码并检查安全设置。", 23, 60, 352, 22),
		]);
		expect(blocks).toHaveLength(1);
	});

	test("short, widely spaced vertical columns are one block, right to left", () => {
		const blocks = groupLines([
			line("春はあけぼの", 191, 13, 39, 186, true),
			line("なりゆく山ぎは", 93, 15, 33, 213, true),
			line("やうやう白く", 143, 16, 34, 183, true),
		]);
		expect(texts(blocks)).toEqual(["春はあけぼの\nやうやう白く\nなりゆく山ぎは"]);
	});

	test("panes side by side with lined-up rows read pane by pane", () => {
		const blocks = groupLines([
			line("General", 20, 20, 80, 24),
			line("Display", 20, 60, 80, 24),
			line("Anna", 600, 22, 50, 22),
			line("See you at eight.", 600, 58, 170, 26),
			line("We have to leave before the storm arrives.", 100, 300, 500, 30),
		]);
		expect(texts(blocks)).toEqual([
			"General",
			"Display",
			"Anna",
			"See you at eight.",
			"We have to leave before the storm arrives.",
		]);
	});

	test("RTL: right-aligned lines stack, columns read right to left", () => {
		const right = [line("مرحبا بكم في التطبيق الجديد", 520, 0, 260, 20), line("اضغط للمتابعة", 640, 26, 140, 20)];
		const left = [line("هذا نص في العمود الأيسر هنا", 20, 0, 260, 20), line("نهاية العمود", 150, 26, 130, 20)];
		const blocks = groupLines([...left, ...right]);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.text).toBe("مرحبا بكم في التطبيق الجديد\nاضغط للمتابعة");
		expect(blocks[1]?.text).toBe("هذا نص في العمود الأيسر هنا\nنهاية العمود");
	});

	test("explicit vertical flag wins over the box shape; empty lines are dropped", () => {
		const blocks = groupLines([line("縦", 0, 0, 20, 20, true), line("  ", 0, 50, 10, 10)]);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.writing).toBe("vertical-rl");
	});

	test("confidence is the length-weighted mean of the lines", () => {
		const blocks = groupLines([
			{ ...line("A long first line of text", 0, 0, 300, 20), confidence: 1 },
			{ ...line("x", 0, 24, 20, 20), confidence: 0 },
		]);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.confidence).toBeCloseTo(25 / 26, 5);
	});
});

describe("BlockIdTracker", () => {
	const block = (id: string, text: string, x: number, y: number): OcrBlock => ({
		id,
		text,
		box: rect(x, y, 100, 20),
		confidence: 0.9,
	});

	test("unchanged and slightly moved blocks keep their ids; new ones get fresh ids", () => {
		const tracker = new BlockIdTracker();
		const first = tracker.assign([block("b0", "Hello", 0, 0), block("b1", "World", 0, 40)]);
		expect(first.map((b) => b.id)).toEqual(["k1", "k2"]);
		// Same place, text changed (a subtitle line updates): same id by overlap.
		const second = tracker.assign([
			block("b0", "Hello!", 2, 1),
			block("b1", "World", 0, 40),
			block("b2", "New", 0, 80),
		]);
		expect(second.map((b) => b.id)).toEqual(["k1", "k2", "k3"]);
	});

	test("scrolling: same text further away keeps its id; text match beats overlap", () => {
		const tracker = new BlockIdTracker();
		tracker.assign([block("b0", "Line one", 0, 0), block("b1", "Line two", 0, 22)]);
		// Scrolled up by 22 px: "Line two" now sits where "Line one" was.
		const next = tracker.assign([block("b0", "Line two", 0, 0), block("b1", "Line three", 0, 22)]);
		expect(next.map((b) => b.id)).toEqual(["k2", "k3"]);
	});

	test("ids are never reused after reset", () => {
		const tracker = new BlockIdTracker();
		tracker.assign([block("b0", "A", 0, 0)]);
		tracker.reset();
		expect(tracker.assign([block("b0", "A", 0, 0)])[0]?.id).toBe("k2");
	});

	test("iou", () => {
		expect(iou(rect(0, 0, 10, 10), rect(0, 0, 10, 10))).toBe(1);
		expect(iou(rect(0, 0, 10, 10), rect(5, 0, 10, 10))).toBeCloseTo(50 / 150, 5);
		expect(iou(rect(0, 0, 10, 10), rect(20, 0, 10, 10))).toBe(0);
	});
});
