// Headless picker overlays (GLIM-44): record what the controller tells them, so tests and
// the harness drive the real PickerController without Electrobun. Plus a hand-advanced scheduler.
import type { Display, PickerViewState } from "@glimpse/core";
import type { OverlayFactory, OverlayWindow, Scheduler } from "../bun/windows/picker-controller.ts";
import type { PickerLoupeMessage, PickerOpenInfo } from "../shared/rpc.ts";

export class FakeOverlay implements OverlayWindow {
	visible = false;
	activated = false;
	closed = false;
	level: "picking" | "belowPopup" = "picking";
	resets: PickerOpenInfo[] = [];
	states: PickerViewState[] = [];
	loupes: PickerLoupeMessage[] = [];
	fades: boolean[] = [];
	shows = 0;

	constructor(readonly display: Display) {}
	reset(info: PickerOpenInfo) {
		this.resets.push(info);
	}
	state(view: PickerViewState) {
		this.states.push(view);
	}
	loupe(m: PickerLoupeMessage) {
		this.loupes.push(m);
	}
	fadeOut(animate: boolean) {
		this.fades.push(animate);
	}
	show(activate: boolean) {
		this.visible = true;
		this.activated = activate;
		this.shows++;
	}
	hide() {
		this.visible = false;
		this.activated = false;
	}
	setLevel(level: "picking" | "belowPopup") {
		this.level = level;
	}
	close() {
		this.closed = true;
		this.visible = false;
	}
	get last(): PickerViewState | undefined {
		return this.states.at(-1);
	}
}

export class FakeOverlayFactory implements OverlayFactory {
	readonly created: FakeOverlay[] = [];
	create(display: Display): FakeOverlay {
		const o = new FakeOverlay(display);
		this.created.push(o);
		return o;
	}
	get live(): FakeOverlay[] {
		return this.created.filter((o) => !o.closed);
	}
}

/** Intervals and timeouts fire only when `advance` passes them. */
export class ManualScheduler implements Scheduler {
	private t = 0;
	private timers: { at: number; every: number | null; fn: () => void; id: number }[] = [];
	private nextId = 0;

	now = () => this.t;

	every(ms: number, fn: () => void): () => void {
		return this.add(ms, ms, fn);
	}
	later(ms: number, fn: () => void): () => void {
		return this.add(ms, null, fn);
	}
	private add(ms: number, every: number | null, fn: () => void): () => void {
		const id = this.nextId++;
		this.timers.push({ at: this.t + ms, every, fn, id });
		return () => {
			this.timers = this.timers.filter((x) => x.id !== id);
		};
	}
	get pending(): number {
		return this.timers.length;
	}
	advance(ms: number): void {
		const end = this.t + ms;
		for (;;) {
			const next = [...this.timers].sort((a, b) => a.at - b.at)[0];
			if (!next || next.at > end) break;
			this.t = next.at;
			if (next.every === null) this.timers = this.timers.filter((x) => x.id !== next.id);
			else next.at += next.every;
			next.fn();
		}
		this.t = end;
	}
}
