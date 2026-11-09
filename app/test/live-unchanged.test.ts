// GLIM-157: Live must only update when the text actually changes. A pinned page whose text
// stays the same, while the mouse moves over it, a small animation plays next to it and a
// hover highlight lights a line (enough pixels to re-read it, and OCR that reads the same line
// a little differently), produces no visible update at all: no popup state change, no change
// mark, no "Updating", no translation, no overlay redraw. A real text change is exactly one
// update. "Only when I refresh" updates only on Refresh. Headless, on the harness's Live
// session runner over an in-memory recording (virtual time).
import { describe, expect, test } from "bun:test";
import { languageCode, type OcrImage, rect } from "@glimpse/core";
import {
	FakeOcrProvider,
	FakeTranslationProvider,
	ManualTimers,
	makeImage,
	ocrBlock,
	ReplayCaptureSource,
} from "@glimpse/core/testing";
import { liveSessionLines, runLiveSession } from "../src/harness/live-session.ts";

const W = 400;
const H = 100;
type Rgb = readonly [number, number, number];
const PAGE: Rgb = [245, 245, 245];
const HOVER: Rgb = [215, 228, 250];
const INK = { one: [30, 30, 30], two: [60, 20, 20], three: [20, 60, 20] } as const satisfies Record<string, Rgb>;
type Ink = keyof typeof INK;
const TEXT: Record<Ink, string> = { one: "扉は閉まっている。", two: "衛兵と話して。", three: "塔の鍵を探して。" };
const LINE1 = rect(20, 20, 360, 24);
const LINE2 = rect(20, 56, 360, 24);

interface Scene {
	/** Line 1's ink (its text). */
	readonly ink?: Ink;
	/** A mouse pointer drawn into the capture at (x, y) (some capture paths include it). */
	readonly cursor?: { x: number; y: number };
	/** A 12 x 12 spinner in the corner, in one of two phases. */
	readonly spinner?: 0 | 1;
	/** The hover highlight behind line 1 (a web page's :hover). */
	readonly hover?: boolean;
	/** Seeded ±10 per channel noise on every pixel (below the per-pixel tolerance). */
	readonly noise?: number;
}

const inside = (r: ReturnType<typeof rect>, x: number, y: number) =>
	x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

/** Glyph-ish strokes: every other 3 px column inside the line. */
const glyph = (r: ReturnType<typeof rect>, x: number, y: number) =>
	inside(r, x, y) && y >= r.y + 6 && y < r.y + r.height - 6 && Math.floor((x - r.x) / 3) % 2 === 0;

function paint(s: Scene) {
	const img = paintClean(s);
	if (s.noise !== undefined) {
		let seed = s.noise * 7919;
		for (let i = 0; i < img.data.length; i++) {
			if (i % 4 === 3) continue;
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			img.data[i] = Math.max(0, Math.min(255, (img.data[i] ?? 0) + (seed % 21) - 10));
		}
	}
	return img;
}

function paintClean(s: Scene) {
	return makeImage(W, H, (x, y) => {
		if (
			s.cursor &&
			x >= s.cursor.x &&
			x < s.cursor.x + 12 &&
			y >= s.cursor.y &&
			y < s.cursor.y + 18 &&
			x - s.cursor.x <= y - s.cursor.y
		)
			return [0, 0, 0];
		if (s.spinner !== undefined && x >= 384 && x < 396 && y >= 84 && y < 96)
			return x < 390 === (s.spinner === 0) ? [120, 120, 120] : PAGE;
		if (glyph(LINE1, x, y)) return INK[s.ink ?? "one"];
		if (glyph(LINE2, x, y)) return INK.two;
		if (s.hover && inside(LINE1, x, y)) return HOVER;
		return PAGE;
	});
}

/** OCR that reads the ink colour of each line; a highlighted line comes back slightly differently. */
function pageOcr() {
	const at = (img: OcrImage, x: number, y: number) => {
		const i = y * img.stride + x * 4;
		return [img.data[i], img.data[i + 1], img.data[i + 2]];
	};
	const read = (img: OcrImage, r: ReturnType<typeof rect>) => {
		const px = at(img, r.x, r.y + 8);
		const ink = (Object.keys(INK) as Ink[]).find((k) => INK[k].every((v, n) => v === px[n]));
		return ink ? TEXT[ink] : null;
	};
	return new FakeOcrProvider({
		blocks: (req) => {
			const img = req.image;
			const hovered = at(img, LINE1.x + 1, LINE1.y + 2).every((v, n) => v === HOVER[n]);
			const one = read(img, LINE1);
			const two = read(img, LINE2);
			return [
				// Real OCR on a lighter background: the full stop is lost, a space creeps in.
				...(one ? [ocrBlock("b1", hovered ? one.replace(/。$/, "").replace("は", "は ") : one, LINE1)] : []),
				...(two ? [ocrBlock("b2", two, LINE2)] : []),
			];
		},
	});
}

async function session(
	frames: { scene: Scene; holdMs: number }[],
	opts: { manual?: boolean; refreshAt?: number[] } = {},
) {
	const timers = new ManualTimers(1_000_000);
	const ocr = pageOcr();
	await ocr.init();
	const translator = new FakeTranslationProvider({ capabilities: { streaming: false } });
	await translator.init();
	const source = new ReplayCaptureSource(
		frames.map((f) => ({ image: paint(f.scene), holdMs: f.holdMs })),
		{ advance: "timed", now: timers.now },
	);
	const durationMs = frames.reduce((n, f) => n + f.holdMs, 0);
	const report = await runLiveSession(source, rect(0, 0, W, H), {
		ocr,
		translation: translator,
		to: languageCode("en"),
		fps: 4,
		diffThreshold: 0.02,
		stabilityMs: 300,
		durationMs,
		timers,
		...(opts.manual ? { update: "manual" as const } : {}),
		...(opts.refreshAt ? { refreshAt: opts.refreshAt } : {}),
	});
	return { report, ocr, translator };
}

/** Popup states after the first fill (both lines translated), before the session ends. */
const afterFirstFill = (popup: readonly { t: number; state: string }[]) => {
	const i = popup.findIndex((p) => /L1 "[^"]+".*L2 "[^"]+"/.test(p.state) && !p.state.includes("pending"));
	return popup.slice(i + 1).filter((p) => !p.state.includes("closed"));
};

const cursorPath = (from: number, to: number, ms: number) => {
	const out: { scene: Scene; holdMs: number }[] = [];
	for (let x = from; x <= to; x += 30) out.push({ scene: { cursor: { x, y: 30 } }, holdMs: ms });
	return out;
};

describe("Live updates only when the text changes (GLIM-157)", () => {
	test("cursor moving, a small animation and a hover highlight over unchanged text: no update at all", async () => {
		const spin: { scene: Scene; holdMs: number }[] = [];
		for (let i = 0; i < 24; i++) spin.push({ scene: { spinner: (i % 2) as 0 | 1 }, holdMs: 125 });
		const { report } = await session([
			{ scene: {}, holdMs: 1500 },
			...cursorPath(10, 370, 100),
			{ scene: { cursor: { x: 370, y: 30 } }, holdMs: 1000 },
			...spin,
			{ scene: { hover: true, cursor: { x: 200, y: 30 } }, holdMs: 1500 },
			{ scene: {}, holdMs: 1500 },
		]);
		const later = afterFirstFill(report.popup);
		expect(later).toEqual([]);
		const after = report.events.filter((e) => e.t > 1000);
		expect(after.filter((e) => e.type === "frame")).toEqual([]);
		expect(after.filter((e) => e.type === "translation")).toEqual([]);
		expect(after.filter((e) => e.type === "status" && e.status !== "stopped")).toEqual([]);
		if (process.env["GLIM_DEBUG"]) console.log(liveSessionLines(report).join("\n"));
	});

	test("pixel noise on every frame (antialiasing, video compression): nothing is read again", async () => {
		const noisy: { scene: Scene; holdMs: number }[] = [];
		for (let i = 0; i < 16; i++) noisy.push({ scene: { noise: i + 1 }, holdMs: 250 });
		const { report, ocr } = await session([{ scene: {}, holdMs: 1000 }, ...noisy]);
		expect(ocr.calls.length).toBe(1);
		expect(afterFirstFill(report.popup)).toEqual([]);
	});

	test("a real text change: exactly one update, marked once", async () => {
		const { report } = await session([
			{ scene: {}, holdMs: 1500 },
			...cursorPath(10, 190, 100),
			{ scene: { ink: "three", cursor: { x: 190, y: 30 } }, holdMs: 3000 },
		]);
		const frames = report.events.filter((e) => e.type === "frame" && e.t > 0);
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ changeSet: ["L1"], removes: [] });
		const later = afterFirstFill(report.popup);
		// The change lands (pending or held, then revealed) and nothing after it.
		expect(later.at(-1)?.state).toBe(
			'running/live set 1 [*L1 "塔の鍵を探して。 [ja>en]" |  L2 "衛兵と話して。 [ja>en]"]',
		);
		expect(later.every((p) => p.t === later[0]?.t)).toBe(true);
	});
});

describe("Update: only when I refresh (GLIM-157)", () => {
	test("the first read, then nothing until Refresh; Refresh reads once and shows the change", async () => {
		const { report, ocr } = await session(
			[
				{ scene: {}, holdMs: 1000 },
				{ scene: { ink: "three" }, holdMs: 3000 },
				{ scene: { ink: "one" }, holdMs: 2000 },
			],
			{ manual: true, refreshAt: [3000, 5000, 5500] },
		);
		// Read at 0, and on each Refresh (5000: back to the first text; 5500: unchanged).
		expect(ocr.calls.length).toBe(2);
		expect(report.stats.ringHits).toBe(2); // the first text again, then the same frame again
		const frames = report.events.filter((e) => e.type === "frame");
		expect(frames.map((e) => Math.round(e.t))).toEqual([0, 3000, 5000]);
		expect(frames[1]).toMatchObject({ changeSet: ["L1"] });
		// Nothing is captured between Refreshes (the loop is paused): a handful of grabs, not 24.
		expect(report.stats.grabs).toBeLessThanOrEqual(5);
		// Each Refresh says "Updating" until it is done, even when nothing changed.
		const statuses = report.events.filter((e) => e.type === "status").map((e) => (e.type === "status" ? e.status : ""));
		expect(statuses).toEqual([
			"starting",
			"live",
			"updating",
			"live",
			"updating",
			"live",
			"updating",
			"live",
			"stopped",
		]);
	});

	test("automatic mode still re-reads by itself; Refresh there reads at once", async () => {
		const { report } = await session(
			[
				{ scene: {}, holdMs: 1000 },
				{ scene: { ink: "three" }, holdMs: 2000 },
			],
			{ refreshAt: [2500] },
		);
		const frames = report.events.filter((e) => e.type === "frame");
		expect(frames).toHaveLength(2);
		expect(frames[1]?.t).toBeLessThan(2000);
	});
});
