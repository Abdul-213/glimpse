// GLIM-121: permission-denied captures from Snip and Live reach ScreenAccess.reportCaptureDenied().
import { describe, expect, test } from "bun:test";
import {
	applySettingsPatch,
	CaptureError,
	type CaptureFrame,
	type CaptureSession,
	type CaptureSource,
	createLogger,
	defaultSettings,
	ProviderRegistry,
	rect,
} from "@glimpse/core";
import { fakeOcrFactory, fakeTranslationFactory, ManualTimers, MemoryLogSink, ocrBlock } from "@glimpse/core/testing";
import { withDeniedReport } from "../src/bun/services/capture/denied-report.ts";
import { LiveService } from "../src/bun/services/live/live-service.ts";
import { settingsEnvFor } from "../src/bun/services/settings-env.ts";
import { TranslationService } from "../src/bun/services/translation/translation-service.ts";

const frame: CaptureFrame = {
	width: 100,
	height: 40,
	data: new Uint8Array(100 * 40 * 4).fill(255),
	rect: rect(0, 0, 100, 40),
	scale: 1,
	displayIds: [1],
	partial: false,
	sequence: 1,
	capturedAt: 0,
};

/** A capture source that fails each call with the code it is given (null = works). */
class FailingSource implements CaptureSource {
	readonly backend = "fake";
	readonly exclusion = "none" as const;
	shot: CaptureError["code"] | null = null;
	open: CaptureError["code"] | null = null;
	next: CaptureError["code"] | null = null;
	closed = 0;
	excluded: number[][] = [];
	disposed = 0;
	displays() {
		return [];
	}
	async capture(): Promise<CaptureFrame> {
		if (this.shot) throw new CaptureError(this.shot, "shot failed", -3801);
		return frame;
	}
	async openSession(): Promise<CaptureSession> {
		if (this.open) throw new CaptureError(this.open, "open failed");
		return {
			rect: frame.rect,
			next: async () => {
				if (this.next) throw new CaptureError(this.next, "read failed");
				return frame;
			},
			close: () => {
				this.closed++;
			},
		};
	}
	setExcludedWindows(ids: readonly number[]): void {
		this.excluded.push([...ids]);
	}
	dispose(): void {
		this.disposed++;
	}
}

describe("withDeniedReport", () => {
	test("permission-denied from a shot, a session open or a frame is reported, then rethrown", async () => {
		const inner = new FailingSource();
		let reports = 0;
		const source = withDeniedReport(inner, () => reports++);
		inner.shot = "permission-denied";
		await expect(source.capture(rect(0, 0, 10, 10))).rejects.toMatchObject({ code: "permission-denied" });
		expect(reports).toBe(1);

		inner.open = "permission-denied";
		await expect(source.openSession(rect(0, 0, 10, 10), { fps: 2 })).rejects.toMatchObject({
			code: "permission-denied",
		});
		expect(reports).toBe(2);

		inner.open = null;
		const session = await source.openSession(rect(0, 0, 10, 10), { fps: 2 });
		expect(await session.next()).toBe(frame);
		inner.next = "permission-denied";
		await expect(session.next()).rejects.toMatchObject({ code: "permission-denied" });
		expect(reports).toBe(3);
		session.close();
		expect(inner.closed).toBe(1);
	});

	test("other failures are not reported; everything else passes through", async () => {
		const inner = new FailingSource();
		let reports = 0;
		const source = withDeniedReport(inner, () => reports++);
		inner.shot = "temporarily-unavailable";
		await expect(source.capture(rect(0, 0, 10, 10))).rejects.toMatchObject({ code: "temporarily-unavailable" });
		inner.shot = null;
		expect(await source.capture(rect(0, 0, 10, 10))).toBe(frame);
		expect(reports).toBe(0);
		expect([source.backend, source.exclusion]).toEqual(["fake", "none"]);
		source.setExcludedWindows([7]);
		source.dispose();
		expect(inner.excluded).toEqual([[7]]);
		expect(inner.disposed).toBe(1);
	});

	test("a throwing reporter never replaces the capture error", async () => {
		const inner = new FailingSource();
		inner.shot = "permission-denied";
		const source = withDeniedReport(inner, () => {
			throw new Error("boom");
		});
		await expect(source.capture(rect(0, 0, 10, 10))).rejects.toBeInstanceOf(CaptureError);
	});
});

function services() {
	const registry = new ProviderRegistry<unknown>();
	registry.register(fakeOcrFactory({ id: "fake-ocr", blocks: [ocrBlock("b1", "こんにちは", rect(0, 0, 50, 20))] }));
	registry.register(fakeTranslationFactory({ id: "fake-translation" }));
	const env = settingsEnvFor("macos", "en-US", registry);
	const settings = applySettingsPatch(
		defaultSettings(env),
		{ providers: { ocr: "fake-ocr", translation: ["fake-translation"] } },
		env,
	).settings;
	const log = createLogger({ sinks: [new MemoryLogSink()], level: "debug" });
	return { registry, settings, log };
}

describe("Snip and Live report a revoked Screen Recording grant", () => {
	test("Snip: the pipeline still ends in its error state, and the denial is reported", async () => {
		const { registry, settings, log } = services();
		const translation = new TranslationService({ registry, ctx: {}, settings: () => settings, log });
		await translation.start();
		const inner = new FailingSource();
		inner.shot = "permission-denied";
		let reports = 0;
		const result = await translation.snip(
			withDeniedReport(inner, () => reports++),
			rect(0, 0, 100, 40),
			() => {},
		);
		expect(reports).toBe(1);
		expect(result.error).toBeDefined();
		await translation.dispose();
	});

	test("Live: a denied frame pauses the session and is reported", async () => {
		const { registry, settings, log } = services();
		const timers = new ManualTimers(1_000_000);
		const translation = new TranslationService({ registry, ctx: {}, settings: () => settings, log, now: timers.now });
		await translation.start();
		const inner = new FailingSource();
		inner.next = "permission-denied";
		let reports = 0;
		const live = new LiveService({
			capture: withDeniedReport(inner, () => reports++),
			openPipeline: () => {
				const s = translation.openLive(() => {});
				return {
					process: (img, o) => s.process(img, o),
					setSources: (x) => s.setSources(x),
					setTarget: (x) => s.setTarget(x),
					close: () => s.close(),
				};
			},
			settings: () => settings,
			frame: () => null,
			log,
			onState: () => {},
			timers,
		});
		await live.start(rect(0, 0, 100, 40));
		await timers.advance(2_000);
		expect(reports).toBeGreaterThanOrEqual(1);
		live.dispose();
		await translation.dispose();
	});
});
