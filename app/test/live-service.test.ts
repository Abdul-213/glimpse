// GLIM-59: pinning a region for Live in the main process. The real TranslationService (fake
// providers), the core LiveRunner, a recorded frame sequence on a manual clock and a fake
// pinned frame: start / pause / resume / stop, lock and unlock, settings applied at runtime,
// tray state, typed events for the popup, and logs without screen text.
import { describe, expect, test } from "bun:test";
import {
	applySettingsPatch,
	createLogger,
	defaultSettings,
	type LiveSessionEvent,
	type OcrImage,
	ProviderRegistry,
	type Rect,
	rect,
	type Settings,
} from "@glimpse/core";
import {
	fakeOcrFactory,
	fakeTranslationFactory,
	ManualTimers,
	MemoryLogSink,
	makeImage,
	ReplayCaptureSource,
} from "@glimpse/core/testing";
import type { FrameTag } from "../src/bun/services/live/frame-layout.ts";
import { type LiveFrame, LiveService, type LiveServiceDeps } from "../src/bun/services/live/live-service.ts";
import { settingsEnvFor } from "../src/bun/services/settings-env.ts";
import { TranslationService } from "../src/bun/services/translation/translation-service.ts";
import type { LiveState } from "../src/bun/tray-menu.ts";

const W = 200;
const H = 50;
type Rgb = readonly [number, number, number];
const strip = (c: Rgb) => makeImage(W, H, (x, y) => (y >= 10 && y < 40 && x >= 10 && x < 190 ? c : [20, 20, 20]));
const RED: Rgb = [220, 40, 40];
const GREEN: Rgb = [40, 200, 40];
const TEXT = new Map([
	["220,40,40", "こんにちは"],
	["40,200,40", "さようなら"],
]);
const REGION = rect(0, 0, W, H);

class FakeFrame implements LiveFrame {
	readonly calls: string[] = [];
	region: Rect | null = null;
	paused = false;
	tag: FrameTag = { kind: "none" };
	disposed = false;
	show(region: Rect): void {
		this.calls.push("show");
		this.region = region;
	}
	hide(): void {
		this.calls.push("hide");
	}
	setPaused(paused: boolean): void {
		this.paused = paused;
	}
	setTag(tag: FrameTag): void {
		this.tag = tag;
	}
	highlight: Rect | null = null;
	setHighlight(box: Rect | null): void {
		this.highlight = box;
	}
	dispose(): void {
		this.disposed = true;
	}
}

async function setup(
	frames: { image: ReturnType<typeof strip>; holdMs: number }[],
	extra: Partial<LiveServiceDeps> = {},
	wrapCapture?: (source: ReplayCaptureSource) => LiveServiceDeps["capture"],
) {
	const timers = new ManualTimers(1_000_000);
	const registry = new ProviderRegistry<unknown>();
	let ocrCalls = 0;
	registry.register(
		fakeOcrFactory({
			id: "fake-ocr",
			blocks: (req: { image: OcrImage }) => {
				ocrCalls++;
				const d = req.image.data;
				const i = 20 * req.image.stride + 20 * 4;
				const text = TEXT.get(`${d[i]},${d[i + 1]},${d[i + 2]}`);
				return text ? [{ id: "b1", text, box: rect(10, 10, 180, 30), confidence: 0.9 }] : [];
			},
		}),
	);
	registry.register(fakeTranslationFactory({ id: "fake-translation" }));
	const env = settingsEnvFor("windows", "en-US", registry);
	let settings: Settings = applySettingsPatch(
		defaultSettings(env),
		{ providers: { ocr: "fake-ocr", translation: ["fake-translation"] } },
		env,
	).settings;
	const sink = new MemoryLogSink();
	const log = createLogger({ sinks: [sink], level: "debug" });
	const translation = new TranslationService({ registry, ctx: {}, settings: () => settings, log, now: timers.now });
	await translation.start();
	const source = new ReplayCaptureSource(frames, { advance: "timed", now: timers.now });
	const states: LiveState[] = [];
	const frameObjs: FakeFrame[] = [];
	let closedPipelines = 0;
	const live = new LiveService({
		capture: wrapCapture ? wrapCapture(source) : source,
		openPipeline: () => {
			const s = translation.openLive(() => {});
			return {
				process: (img, o) => s.process(img, o),
				setSources: (x) => s.setSources(x),
				setTarget: (x) => s.setTarget(x),
				close: () => {
					closedPipelines++;
					s.close();
				},
			};
		},
		settings: () => settings,
		frame: () => {
			const f = new FakeFrame();
			frameObjs.push(f);
			return f;
		},
		log,
		onState: (s) => states.push(s),
		timers,
		newSessionId: () => `s${frameObjs.length + 1}`,
		...extra,
	});
	const events: LiveSessionEvent[] = [];
	live.onEvent((e) => events.push(e));
	const t0 = timers.now();
	return {
		live,
		timers,
		events,
		states,
		frames: frameObjs,
		sink,
		at: (ms: number) => timers.advanceTo(t0 + ms),
		ocrCalls: () => ocrCalls,
		closedPipelines: () => closedPipelines,
		setSettings: (patch: Record<string, unknown>) => {
			const previous = settings;
			settings = applySettingsPatch(settings, patch, env).settings;
			live.applySettings(settings, previous);
		},
	};
}

describe("LiveService (GLIM-59)", () => {
	test("pin: frame shown with the Live tag, tray running, typed events for the popup", async () => {
		const s = await setup([
			{ image: strip(RED), holdMs: 1000 },
			{ image: strip(GREEN), holdMs: 5000 },
		]);
		await s.live.start(REGION);
		await s.at(2000);
		expect(s.live.active).toBe(true);
		expect(s.frames[0]?.region).toEqual(REGION);
		expect(s.frames[0]?.tag).toEqual({ kind: "live" });
		expect(s.frames[0]?.paused).toBe(false);
		expect(s.states).toEqual(["running"]);
		const frames = s.events.filter((e) => e.type === "frame");
		expect(
			frames.map((e) => (e.type === "frame" ? [e.frameSeq, e.changeSet.length, e.upserts[0]?.source] : null)),
		).toEqual([
			[1, 0, "こんにちは"],
			[2, 1, "さようなら"],
		]);
		expect(s.events.some((e) => e.type === "translation" && e.final && e.text.includes("さようなら"))).toBe(true);
		expect(s.ocrCalls()).toBe(2);
		s.live.stop();
	});

	test("pause / resume: tray, frame ticks and tag follow; unlock never resumes a user pause", async () => {
		const s = await setup([{ image: strip(RED), holdMs: 10_000 }]);
		await s.live.start(REGION);
		await s.at(500);
		s.live.pause();
		const f = s.frames[0];
		expect(f?.paused).toBe(true);
		expect(f?.tag).toEqual({ kind: "paused" });
		expect(s.states.at(-1)).toBe("paused");
		s.live.systemEvent("lock");
		s.live.systemEvent("unlock");
		expect(s.live.status).toBe("paused");
		s.live.resume();
		expect(s.live.status).toBe("live");
		expect(f?.paused).toBe(false);
		expect(s.states.at(-1)).toBe("running");
		// Lock while running: auto-pause, auto-resume.
		s.live.systemEvent("lock");
		expect(s.live.status).toBe("paused");
		s.live.systemEvent("unlock");
		expect(s.live.status).toBe("live");
		s.live.stop();
	});

	test("the region tag hides while the popup is shown", async () => {
		const s = await setup([{ image: strip(RED), holdMs: 10_000 }]);
		await s.live.start(REGION);
		s.live.setPopupVisible(true);
		expect(s.frames[0]?.tag).toEqual({ kind: "none" });
		s.live.setPopupVisible(false);
		expect(s.frames[0]?.tag).toEqual({ kind: "live" });
		s.live.stop();
	});

	test("stop unpins: frame removed, capture and pipeline closed, tray off, 'stopped' sent", async () => {
		const s = await setup([{ image: strip(RED), holdMs: 10_000 }]);
		await s.live.start(REGION);
		await s.at(500);
		s.live.stop();
		expect(s.live.active).toBe(false);
		expect(s.frames[0]?.disposed).toBe(true);
		expect(s.closedPipelines()).toBe(1);
		expect(s.states.at(-1)).toBe("off");
		expect(s.events.at(-1)).toMatchObject({ type: "status", status: "stopped" });
		const grabs = s.live.stats();
		expect(grabs).toBeNull();
		await s.at(3000);
		expect(s.ocrCalls()).toBe(1);
	});

	test("re-pin replaces the session; Live settings and languages apply without restarting", async () => {
		const s = await setup([{ image: strip(RED), holdMs: 10_000 }]);
		await s.live.start(REGION);
		await s.at(500);
		await s.live.start(rect(0, 0, 100, 50));
		expect(s.frames).toHaveLength(2);
		expect(s.frames[0]?.disposed).toBe(true);
		expect(s.live.region).toEqual(rect(0, 0, 100, 50));
		s.setSettings({ live: { fps: 2, stabilityMs: 500 } });
		expect(s.live.stats()?.loop.fps).toBe(2);
		await s.at(1000);
		const before = s.ocrCalls();
		s.setSettings({ language: { target: "de" } });
		await s.at(2000);
		// A new target means a re-read of the same pixels.
		expect(s.ocrCalls()).toBe(before + 1);
		s.live.stop();
	});

	test("a capture session that can't open reports an error and pins nothing", async () => {
		const s = await setup([{ image: strip(RED), holdMs: 1000 }]);
		await s.live.start(rect(5000, 5000, 10, 10));
		expect(s.live.active).toBe(false);
		expect(s.events.at(-1)).toMatchObject({ type: "status", status: "error", error: { kind: "captureFailed" } });
		expect(s.frames).toHaveLength(0);
	});

	test("hovering a block highlights its box on the frame, in global logical coordinates", async () => {
		const s = await setup([{ image: strip(RED), holdMs: 10_000 }]);
		await s.live.start(rect(50, 0, 100, 50));
		s.live.highlightBlock(rect(20, 10, 100, 20), { width: 200, height: 100 });
		expect(s.frames[0]?.highlight).toEqual(rect(60, 5, 50, 10));
		s.live.highlightBlock(null, null);
		expect(s.frames[0]?.highlight).toBeNull();
		s.live.stop();
	});

	test("logs carry counts and states, never the screen text", async () => {
		const s = await setup([
			{ image: strip(RED), holdMs: 1000 },
			{ image: strip(GREEN), holdMs: 2000 },
		]);
		await s.live.start(REGION);
		await s.at(2500);
		s.live.stop();
		const text = s.sink.text();
		expect(text).toContain("live: pinned");
		expect(text).toContain("live: stopped");
		expect(text).toContain("ocrRuns");
		expect(text).not.toContain("こんにちは");
		expect(text).not.toContain("さようなら");
	});
});

describe("LiveService cloud consent (GLIM-79, live-popup.md L10)", () => {
	const cloud = { id: "cloud:google-translate-v2", kind: "cloud" as const, name: "Google Cloud Translation" };
	const local = { id: "fake-ocr", kind: "local" as const, name: "Fake OCR" };

	test("a cloud translator: opened + consent, nothing captured until answered; cloud remembers", async () => {
		const remembered: string[] = [];
		const s = await setup([{ image: strip(RED), holdMs: 10_000 }], {
			providers: () => ({ ocr: local, translation: cloud }),
			rememberConsent: (id) => remembered.push(id),
		});
		await s.live.start(REGION);
		await s.at(2000);
		expect(s.events.map((e) => e.type)).toEqual(["opened", "consent"]);
		expect(s.live.status).toBe("consent");
		expect(s.live.active).toBe(true);
		expect(s.ocrCalls()).toBe(0);
		expect(s.frames[0]?.paused).toBe(true);
		const id = s.live.sessionId ?? "";
		await s.live.answerConsent(id, "cloud", true);
		await s.at(3000);
		expect(remembered).toEqual([cloud.id]);
		expect(s.ocrCalls()).toBe(1);
		const reopened = s.events.filter((e) => e.type === "opened");
		expect(reopened.length).toBe(2);
		expect(reopened[1]?.type === "opened" && reopened[1].providers.cloud?.id).toBe(cloud.id);
		// The pending frame is reused, and the tag names the company while the popup is hidden.
		expect(s.frames.length).toBe(1);
		expect(s.frames[0]?.tag).toEqual({ kind: "cloud", company: "Google" });
		s.live.stop();
	});

	test("use on-device: no cloud for the session; cancel unpins", async () => {
		const s = await setup([{ image: strip(RED), holdMs: 10_000 }], {
			providers: () => ({ ocr: local, translation: cloud }),
		});
		await s.live.start(REGION);
		await s.live.answerConsent(s.live.sessionId ?? "", "local");
		await s.at(1000);
		const last = s.events.filter((e) => e.type === "opened").at(-1);
		expect(last?.type === "opened" && last.providers).toEqual({ cloud: null, localOnly: true });
		s.live.stop();
		await s.live.start(REGION);
		const id = s.live.sessionId ?? "";
		await s.live.answerConsent(id, "cancel");
		expect(s.live.active).toBe(false);
		expect(s.events.at(-1)).toMatchObject({ type: "status", sessionId: id, status: "stopped" });
		expect(s.frames.at(-1)?.disposed).toBe(true);
	});

	test("remembered translator: no question", async () => {
		const s = await setup([{ image: strip(RED), holdMs: 10_000 }], {
			providers: () => ({ ocr: local, translation: cloud }),
		});
		s.setSettings({ cloud: { liveConsent: [cloud.id] } });
		await s.live.start(REGION);
		expect(s.events.some((e) => e.type === "consent")).toBe(false);
		s.live.stop();
	});
});

describe("unpin releases every capture resource (GLIM-81)", () => {
	test("Stop: capture session, pipeline, frame and every session timer go", async () => {
		const calls: string[] = [];
		const t = await setup([{ image: strip(RED), holdMs: 10_000 }], {}, (source) => ({
			openSession: async (r, o) => {
				const c = await source.openSession(r, o);
				calls.push("open");
				return {
					rect: c.rect,
					next: () => c.next(),
					close: () => {
						calls.push("close");
						c.close();
					},
				};
			},
		}));
		await t.live.start(REGION);
		await t.at(1500);
		expect(t.ocrCalls()).toBe(1);
		const idle = t.timers.pending;
		t.live.stop();
		expect(calls).toEqual(["open", "close"]);
		expect(t.closedPipelines()).toBe(1);
		expect(t.frames[0]?.disposed).toBe(true);
		// The loop's next grab (and any updating / empty timer) is gone from the clock; what is
		// left belongs to the translation service (cache timers), not the session.
		expect(t.timers.pending).toBeLessThan(idle);
		await t.at(5000);
		expect(t.ocrCalls()).toBe(1);
		expect(calls).toEqual(["open", "close"]);
	});
});
