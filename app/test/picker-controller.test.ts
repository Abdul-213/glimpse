// GLIM-44: the picker window controller with headless overlays, plus hotkeys.
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_HOTKEYS,
	type Display,
	defaultSettings,
	languageCode,
	NO_MODIFIERS,
	nullLogger,
	type PickerOutcome,
	ProviderRegistry,
	type RegionSelected,
	rect,
	type SettingsEnv,
} from "@glimpse/core";
import { FakePointer, RecordingFocusKeeper, SolidPixelSampler, StaticWindowList } from "@glimpse/core/testing";
import { createFileCaptureSource } from "../src/bun/services/capture/file.ts";
import { SAMPLE_FRAMES_DIR } from "../src/bun/services/capture/index.ts";
import { describeOSStatus, hotkeyLabel, toCarbon, toElectrobunAccelerator } from "../src/bun/services/hotkey-keys.ts";
import { type HotkeyBackend, HotkeyService } from "../src/bun/services/hotkeys.ts";
import { CarbonHotkeyBackend } from "../src/bun/services/hotkeys-carbon.ts";
import {
	displaySignature,
	EXIT_FADE_MS,
	overlayMismatch,
	PickerController,
	type PickerSettings,
	pickerSettingsFrom,
} from "../src/bun/windows/picker-controller.ts";
import { FakeOverlayFactory, ManualScheduler } from "../src/harness/overlays.ts";
import { dragSteps, runPick } from "../src/harness/pick.ts";

const env: SettingsEnv = {
	hotkeys: DEFAULT_HOTKEYS.windows,
	providers: new ProviderRegistry<unknown>().configSchema(),
	targetLanguage: languageCode("en"),
};

const d = (id: number, x: number, scale = 1): Display => ({
	id,
	bounds: rect(x, 0, 1280, 720),
	workArea: rect(x, 28, 1280, 692),
	scaleFactor: scale,
	isPrimary: id === 1,
});

function setup(
	opts: {
		displays?: Display[];
		at?: { x: number; y: number };
		reducedMotion?: boolean;
		settings?: () => PickerSettings;
	} = {},
) {
	let displays = opts.displays ?? [d(1, 0), d(2, 1280, 2)];
	const factory = new FakeOverlayFactory();
	const scheduler = new ManualScheduler();
	const pointer = new FakePointer(opts.at ?? { x: 300, y: 300 });
	const focus = new RecordingFocusKeeper();
	const controller = new PickerController({
		factory,
		displays: () => displays,
		probe: pointer,
		windows: new StaticWindowList([{ rect: rect(100, 100, 400, 300), pid: 9, z: 0, appName: "Notes" }]),
		sampler: new SolidPixelSampler(),
		focus,
		os: "windows",
		log: nullLogger,
		now: scheduler.now,
		scheduler,
		settings:
			opts.settings ??
			(() => ({ confirmOnRelease: true, showLoupe: true, reducedMotion: opts.reducedMotion ?? false })),
	});
	const regions: RegionSelected[] = [];
	const outcomes: PickerOutcome[] = [];
	controller.onOutcome((o) => outcomes.push(o));
	return {
		controller,
		factory,
		scheduler,
		pointer,
		focus,
		regions,
		outcomes,
		setDisplays: (x: Display[]) => {
			displays = x;
		},
	};
}

const ptr = (displayId: number, phase: "down" | "move" | "up", x: number, y: number) => ({
	displayId,
	phase,
	x,
	y,
	button: 0,
	detail: 1,
	mods: NO_MODIFIERS,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("PickerController", () => {
	test("pre-creates one hidden overlay per display", () => {
		const { controller, factory } = setup();
		controller.prepare();
		expect(factory.created.map((o) => o.display.id)).toEqual([1, 2]);
		expect(factory.created.every((o) => !o.visible)).toBe(true);
		controller.prepare();
		expect(factory.created).toHaveLength(2); // nothing recreated when nothing changed
	});

	test("open shows every overlay; only the pointer's is activated (key window)", () => {
		const { controller, factory } = setup({ at: { x: 1500, y: 300 } });
		controller.prepare();
		controller.open("snip");
		const [a, b] = factory.created;
		expect(a?.visible && b?.visible).toBe(true);
		expect(a?.activated).toBe(false);
		expect(b?.activated).toBe(true);
		expect(a?.resets.at(-1)).toEqual({ mode: "snip", reducedMotion: false, showLoupe: true });
		// The first frame is already there before the windows show.
		expect(a?.last?.pointerDisplayId).toBe(2);
		expect(controller.isOpen).toBe(true);
	});

	test("drag on one overlay: every overlay gets the state; release emits RegionSelected and hides", async () => {
		const { controller, factory, scheduler, regions, outcomes } = setup();
		controller.onRegionSelected((r) => {
			regions.push(r);
			return undefined;
		});
		controller.open("snip");
		controller.viewPointer(ptr(1, "down", 600, 200));
		controller.viewPointer(ptr(1, "move", 700, 300));
		await flush();
		for (const o of factory.created) expect(o.last?.selection).toEqual(rect(600, 200, 100, 100));
		controller.viewPointer(ptr(1, "up", 800, 400));
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({ mode: "snip", rect: rect(600, 200, 200, 200), source: "drag" });
		expect(outcomes[0]?.kind).toBe("confirmed");
		expect(factory.created.every((o) => o.fades.at(-1) === true)).toBe(true);
		expect(factory.created.every((o) => o.visible)).toBe(true); // fading
		scheduler.advance(EXIT_FADE_MS);
		expect(factory.created.every((o) => !o.visible)).toBe(true);
		expect(factory.created.every((o) => !o.closed)).toBe(true); // hidden, kept for next time
		expect(controller.isOpen).toBe(false);
	});

	test("Show magnifier and Translate on release are read on every open (GLIM-105)", () => {
		let current = defaultSettings(env);
		const { controller, factory, regions } = setup({ settings: () => pickerSettingsFrom(current) });
		controller.onRegionSelected((r) => {
			regions.push(r);
			return undefined;
		});
		controller.open("snip");
		expect(factory.created[0]?.resets.at(-1)).toMatchObject({ showLoupe: true });
		controller.cancel();

		current = { ...current, picker: { showLoupe: false, confirmOnRelease: false } };
		controller.open("snip");
		expect(factory.created[0]?.resets.at(-1)).toMatchObject({ showLoupe: false });
		controller.viewPointer(ptr(1, "down", 600, 200));
		controller.viewPointer(ptr(1, "move", 700, 300));
		controller.viewPointer(ptr(1, "up", 800, 400));
		// Release lands in adjusting: nothing selected until Enter.
		expect(regions).toHaveLength(0);
		expect(controller.isOpen).toBe(true);
		controller.viewKey({ displayId: 1, key: "Enter", down: true, repeat: false, mods: NO_MODIFIERS });
		expect(regions).toHaveLength(1);
	});

	test("a Snip listener can keep the overlays as the results layer until dismiss()", () => {
		const { controller, factory, scheduler } = setup({ reducedMotion: true });
		controller.onRegionSelected(() => "keep");
		controller.open("snip");
		controller.viewKey({ displayId: 1, key: "ArrowRight", down: true, repeat: false, mods: NO_MODIFIERS });
		controller.viewKey({ displayId: 1, key: "Enter", down: true, repeat: false, mods: NO_MODIFIERS });
		expect(factory.created.every((o) => o.visible && o.level === "belowPopup")).toBe(true);
		expect(factory.created[0]?.last?.scrim).toBe(false);
		controller.dismiss();
		scheduler.advance(EXIT_FADE_MS);
		expect(factory.created.every((o) => !o.visible)).toBe(true);
	});

	test("a press on the results layer is reported as a click outside the Snip popup (GLIM-72)", () => {
		const { controller, factory } = setup({ reducedMotion: true });
		let clicks = 0;
		controller.onResultsPointerDown(() => clicks++);
		controller.onRegionSelected(() => "keep");
		// Not reported while picking.
		controller.open("snip");
		controller.viewKey({ displayId: 1, key: "ArrowRight", down: true, repeat: false, mods: NO_MODIFIERS });
		controller.viewKey({ displayId: 1, key: "Enter", down: true, repeat: false, mods: NO_MODIFIERS });
		expect(clicks).toBe(0);
		controller.viewPointer(ptr(2, "move", 50, 50));
		controller.viewPointer(ptr(2, "down", 50, 50));
		controller.viewPointer(ptr(2, "up", 50, 50));
		expect(clicks).toBe(1);
		expect(controller.isOpen).toBe(false);
		controller.dismiss();
		controller.viewPointer(ptr(1, "down", 50, 50));
		expect(clicks).toBe(1);
		expect(factory.created.length).toBe(2);
	});

	test("Live confirm hides even if a listener asks to keep", () => {
		const { controller, factory } = setup({ reducedMotion: true });
		controller.onRegionSelected(() => "keep");
		controller.open("live");
		controller.viewKey({ displayId: 1, key: "ArrowRight", down: true, repeat: false, mods: NO_MODIFIERS });
		controller.viewKey({ displayId: 1, key: "Enter", down: true, repeat: false, mods: NO_MODIFIERS });
		expect(factory.created.every((o) => !o.visible)).toBe(true);
	});

	test("toggle: the same mode's command cancels, the other mode's switches", () => {
		const { controller, outcomes } = setup();
		controller.toggle("snip");
		controller.toggle("live");
		expect(controller.mode).toBe("live");
		controller.toggle("live");
		expect(outcomes.at(-1)).toEqual({ kind: "cancelled", reason: "hotkey" });
		expect(controller.isOpen).toBe(false);
	});

	test("Esc from a view cancels and hides at once with reduced motion", () => {
		const { controller, factory, outcomes } = setup({ reducedMotion: true });
		controller.open("snip");
		controller.viewKey({ displayId: 2, key: "Escape", down: true, repeat: false, mods: NO_MODIFIERS });
		expect(outcomes.at(-1)).toEqual({ kind: "cancelled", reason: "escape" });
		expect(factory.created.every((o) => !o.visible && o.fades.at(-1) === false)).toBe(true);
	});

	test("a changed display layout recreates the overlays on the next open", () => {
		const { controller, factory, setDisplays } = setup();
		controller.prepare();
		setDisplays([d(1, 0)]);
		controller.open("snip");
		expect(factory.created.filter((o) => o.closed)).toHaveLength(2);
		expect(factory.live.map((o) => o.display.id)).toEqual([1]);
	});

	test("ticks at 60 Hz while open: the loupe gets pixels; ticking stops when it closes", async () => {
		const { controller, factory, scheduler } = setup();
		controller.open("snip");
		scheduler.advance(16);
		await flush();
		expect(factory.created[0]?.loupes.length).toBe(1);
		expect(factory.created[0]?.loupes[0]?.rgba.length).toBe(Math.ceil((15 * 15 * 4) / 3) * 4);
		controller.cancel();
		scheduler.advance(EXIT_FADE_MS);
		expect(scheduler.pending).toBe(0);
	});

	test("viewInit replays the current reset and state to a view that loaded late", async () => {
		const { controller, factory } = setup();
		controller.open("snip");
		await flush(); // let the window list land first
		const o = factory.created[1];
		const before = o?.states.length ?? 0;
		const init = controller.viewInit(2);
		expect(init).toMatchObject({ displayId: 2, origin: { x: 1280, y: 0 }, scaleFactor: 2, os: "windows" });
		await flush();
		expect(o?.states.length).toBe(before + 1);
		expect(controller.viewInit(99)).toBeNull();
	});

	test("input from an unknown display is ignored", () => {
		const { controller } = setup();
		controller.open("snip");
		controller.viewPointer(ptr(42, "down", 1, 1));
		expect(controller.current?.snapshot.press).toBeNull();
	});

	test("dispose closes every overlay", () => {
		const { controller, factory } = setup();
		controller.open("snip");
		controller.dispose();
		expect(factory.created.every((o) => o.closed)).toBe(true);
	});

	test("overlayMismatch reports a window that doesn't cover its display or has the wrong DPI", () => {
		expect(overlayMismatch(d(1, 0, 1.5), { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1.5 })).toBeNull();
		expect(overlayMismatch(d(1, 0, 1.5), { innerWidth: 1920, innerHeight: 720, devicePixelRatio: 1 })).toBe(
			"width 1920 != 1280, devicePixelRatio 1 != scale 1.5",
		);
		expect(overlayMismatch(d(1, 0), {})).toBeNull();
	});

	test("display signature changes with scale", () => {
		expect(displaySignature([d(1, 0)])).not.toBe(displaySignature([d(1, 0, 2)]));
	});
});

describe("hotkey key mapping", () => {
	test("Electrobun accelerators", () => {
		expect(toElectrobunAccelerator("Alt+Shift+S")).toBe("Alt+Shift+S");
		expect(toElectrobunAccelerator("Ctrl+Meta+L")).toBe("Control+Super+L");
		expect(toElectrobunAccelerator("Escape")).toBeNull();
	});

	test("Carbon codes (GLIM-23 macOS defaults)", () => {
		expect(toCarbon("Ctrl+Shift+S")).toEqual({ keyCode: 0x01, mods: 0x1200 });
		expect(toCarbon("Ctrl+Shift+L")).toEqual({ keyCode: 0x25, mods: 0x1200 });
		expect(toCarbon("Ctrl+Meta+F9")).toEqual({ keyCode: 0x65, mods: 0x1100 });
		expect(describeOSStatus(-9878)).toContain("another app");
	});

	test("labels use OS glyphs", () => {
		expect(hotkeyLabel("Ctrl+Shift+S", "macos")).toBe("⌃⇧S");
		expect(hotkeyLabel("Alt+Shift+S", "windows")).toBe("Alt+Shift+S");
	});
});

describe("HotkeyService", () => {
	class FakeBackend implements HotkeyBackend {
		readonly name = "fake";
		held = new Set(["Alt+Shift+L"]);
		registered = new Map<string, () => void>();
		disposed = false;
		register(hotkey: string, onPress: () => void) {
			if (this.held.has(hotkey)) return { ok: false, detail: "taken" };
			this.registered.set(hotkey, onPress);
			return { ok: true, detail: "ok" };
		}
		unregister(hotkey: string) {
			this.registered.delete(hotkey);
		}
		dispose() {
			this.disposed = true;
		}
	}
	const bindings = {
		snip: "Alt+Shift+S",
		live: "Alt+Shift+L",
		pauseLive: null,
		resnip: null,
		toggleLivePopup: null,
		focusLivePopup: null,
		refreshLive: null,
	};

	test("registers bound actions, reports conflicts without rebinding, fires handlers", () => {
		const backend = new FakeBackend();
		const service = new HotkeyService(backend, nullLogger);
		let snips = 0;
		const statuses = service.apply(bindings, { snip: () => snips++, live: () => {}, pauseLive: () => {} });
		expect(statuses.map((s) => [s.action, s.state])).toEqual([
			["snip", "registered"],
			["live", "conflict"],
			["pauseLive", "unbound"],
		]);
		backend.registered.get("Alt+Shift+S")?.();
		expect(snips).toBe(1);
	});

	test("re-apply unregisters the old combo; dispose releases everything", () => {
		const backend = new FakeBackend();
		const service = new HotkeyService(backend, nullLogger);
		service.apply(bindings, { snip: () => {} });
		service.apply({ ...bindings, snip: "Alt+Shift+Y" }, { snip: () => {} });
		expect([...backend.registered.keys()]).toEqual(["Alt+Shift+Y"]);
		service.dispose();
		expect(backend.registered.size).toBe(0);
		expect(backend.disposed).toBe(true);
	});

	test("no backend: every bound action is unavailable", () => {
		const service = new HotkeyService(null, nullLogger, "libglimpse.dylib not found");
		expect(service.apply(bindings, { snip: () => {} })[0]).toMatchObject({
			state: "unavailable",
			detail: "libglimpse.dylib not found",
		});
	});

	test("Carbon backend maps codes, surfaces OSStatus, routes presses by id", () => {
		const calls: string[] = [];
		let press: ((id: number) => void) | null = null;
		const backend = new CarbonHotkeyBackend({
			hotkeyInit: (cb) => {
				press = cb;
				calls.push("init");
				return 0;
			},
			hotkeyRegister: (id, key, mods) => {
				calls.push(`reg ${id} ${key} ${mods}`);
				return key === 0x25 ? -9878 : 0;
			},
			hotkeyUnregister: (id) => {
				calls.push(`unreg ${id}`);
				return 0;
			},
			hotkeyUnregisterAll: () => {},
			hotkeyShutdown: () => calls.push("shutdown"),
		});
		let fired = 0;
		expect(backend.register("Ctrl+Shift+S", () => fired++).ok).toBe(true);
		const taken = backend.register("Ctrl+Shift+L", () => {});
		expect(taken).toEqual({ ok: false, detail: describeOSStatus(-9878) });
		(press as ((id: number) => void) | null)?.(0);
		expect(fired).toBe(1);
		backend.unregister("Ctrl+Shift+S");
		backend.dispose();
		expect(calls).toEqual(["init", "reg 0 1 4608", "reg 1 37 4608", "unreg 0", "shutdown"]);
	});
});

describe("harness pick over the sample recording", () => {
	test("drag → RegionSelected → capture, overlays hidden afterwards", async () => {
		const source = createFileCaptureSource(SAMPLE_FRAMES_DIR);
		try {
			const r = await runPick(source, [...dragSteps({ x: 20, y: 15 }, { x: 160, y: 90 }), { wait: 50 }]);
			expect(r.region?.rect).toEqual(rect(20, 15, 140, 75));
			expect([r.frame?.width, r.frame?.height]).toEqual([280, 150]);
			expect(r.overlaysHidden).toBe(true);
			// GLIM-54: across the 2x / 1x seam at x 200. The drag starts on display 1, whose
			// overlay keeps reporting (pointer capture); points past its edge come from the cursor.
			const seam = await runPick(source, [...dragSteps({ x: 150, y: 20 }, { x: 300, y: 100 }), { wait: 50 }]);
			expect(seam.region?.rect).toEqual(rect(150, 20, 150, 80));
			expect(seam.region?.pieces.map((p) => [p.displayId, p.physical])).toEqual([
				[1, rect(300, 40, 100, 160)],
				[2, rect(0, 20, 100, 80)],
			]);
			// One output image at the highest scale; the 1x part is upsampled by the capture plan.
			expect([seam.frame?.width, seam.frame?.height, seam.frame?.scale]).toEqual([300, 160, 2]);
			const esc = await runPick(source, [{ move: { x: 10, y: 10 } }, { key: "Escape" }]);
			expect(esc.outcome).toEqual({ kind: "cancelled", reason: "escape" });
			expect(esc.frame).toBeNull();
		} finally {
			source.dispose();
		}
	});
});
