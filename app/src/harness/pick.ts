// Headless region picker (GLIM-44, GLIM-86): runs the real PickerController and
// PickerSession over headless overlays, feeds a scripted gesture as overlay input, and
// hands the RegionSelected to the capture service, the way Snip / Live will.
import {
	type CaptureFrame,
	CapturePixelSampler,
	type CaptureSource,
	displayAt,
	type Modifiers,
	NO_MODIFIERS,
	nullLogger,
	type PickerMode,
	type PickerOutcome,
	type Point,
	type RegionSelected,
	type ScreenWindow,
	type WindowListSource,
} from "@glimpse/core";
import { PickerController } from "../bun/windows/picker-controller.ts";
import { FakeOverlayFactory, ManualScheduler } from "./overlays.ts";

/** One scripted input. Points are global logical. */
export type PickStep =
	| { readonly move: Point }
	| { readonly down: Point; readonly button?: number; readonly mods?: Partial<Modifiers> }
	| { readonly up: Point; readonly mods?: Partial<Modifiers>; readonly detail?: number }
	| { readonly key: string; readonly mods?: Partial<Modifiers> }
	| { readonly wait: number };

/** A press-drag-release from `from` to `to` in `steps` moves. */
export function dragSteps(from: Point, to: Point, steps = 8, mods: Partial<Modifiers> = {}): PickStep[] {
	const out: PickStep[] = [{ move: from }, { down: from, mods }];
	for (let i = 1; i <= steps; i++) {
		out.push({ move: { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps } });
	}
	out.push({ up: to, mods });
	return out;
}

export interface PickResult {
	readonly outcome: PickerOutcome | null;
	readonly region: RegionSelected | null;
	/** The captured selection (confirmed picks only). */
	readonly frame: CaptureFrame | null;
	/** State pushes per display, and loupe patches sent. */
	readonly statesPerDisplay: Record<number, number>;
	readonly loupes: number;
	/** Every overlay is hidden again (nothing orphaned on screen). */
	readonly overlaysHidden: boolean;
}

export interface PickOptions {
	readonly mode?: PickerMode;
	readonly windows?: readonly ScreenWindow[];
	readonly os?: "macos" | "windows" | "linux";
}

export async function runPick(
	source: CaptureSource,
	steps: readonly PickStep[],
	o: PickOptions = {},
): Promise<PickResult> {
	const factory = new FakeOverlayFactory();
	const scheduler = new ManualScheduler();
	const first = steps.find((s) => "move" in s || "down" in s);
	const start = first && "move" in first ? first.move : first && "down" in first ? first.down : { x: 0, y: 0 };
	// Electrobun's Screen API stand-in: the cursor is wherever the script last put it.
	const pointer = { at: start, cursor: () => pointer.at, primaryDown: () => false };
	const windows: WindowListSource = { list: async () => o.windows ?? [] };
	const controller = new PickerController({
		factory,
		displays: () => source.displays(),
		probe: pointer,
		windows,
		sampler: new CapturePixelSampler(source),
		focus: { save: () => {}, restore: () => false },
		os: o.os ?? "linux",
		log: nullLogger,
		now: scheduler.now,
		scheduler,
		settings: () => ({ confirmOnRelease: true, showLoupe: true, reducedMotion: true }),
	});
	let outcome: PickerOutcome | null = null;
	controller.onOutcome((x) => {
		outcome = x;
	});
	controller.open(o.mode ?? "snip");
	await Bun.sleep(0); // the window list lands

	const displays = source.displays();
	let pressDisplay: number | null = null;
	const local = (p: Point) => {
		// Like pointer capture: a pressed drag keeps reporting to the overlay it started on.
		const id = pressDisplay ?? displayAt(displays, p)?.id ?? displays[0]?.id ?? 0;
		const d = displays.find((x) => x.id === id);
		return { displayId: id, x: p.x - (d?.bounds.x ?? 0), y: p.y - (d?.bounds.y ?? 0) };
	};
	const mods = (m?: Partial<Modifiers>) => ({ ...NO_MODIFIERS, ...m });
	for (const s of steps) {
		if ("wait" in s) {
			scheduler.advance(s.wait);
			await Bun.sleep(0);
		} else if ("move" in s) {
			pointer.at = s.move;
			controller.viewPointer({ ...local(s.move), phase: "move", button: 0, detail: 0, mods: NO_MODIFIERS });
		} else if ("down" in s) {
			pointer.at = s.down;
			const l = local(s.down);
			pressDisplay = l.displayId;
			controller.viewPointer({ ...l, phase: "down", button: s.button ?? 0, detail: 1, mods: mods(s.mods) });
		} else if ("up" in s) {
			pointer.at = s.up;
			controller.viewPointer({ ...local(s.up), phase: "up", button: 0, detail: s.detail ?? 1, mods: mods(s.mods) });
			pressDisplay = null;
		} else {
			const id = displayAt(displays, pointer.at)?.id ?? 0;
			controller.viewKey({ displayId: id, key: s.key, down: true, repeat: false, mods: mods(s.mods) });
			controller.viewKey({ displayId: id, key: s.key, down: false, repeat: false, mods: mods(s.mods) });
		}
	}
	scheduler.advance(100);
	await Bun.sleep(0);
	const final = outcome as PickerOutcome | null;
	const region = final?.kind === "confirmed" ? final.region : null;
	const frame = region ? await source.capture(region.rect) : null;
	const result: PickResult = {
		outcome: final,
		region,
		frame,
		statesPerDisplay: Object.fromEntries(factory.created.map((x) => [x.display.id, x.states.length])),
		loupes: factory.created.reduce((n, x) => n + x.loupes.length, 0),
		overlaysHidden: factory.created.every((x) => !x.visible),
	};
	controller.dispose();
	return result;
}
