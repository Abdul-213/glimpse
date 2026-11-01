// The on-screen frame around a pinned Live region (GLIM-90; live-popup.md §2.4, §12.2):
// corner ticks outside the region, accent while running and grey while paused, the region tag
// while the popup is hidden, and the linked-block highlight. Drawn by the native helper in a
// click-through, always-on-top window that is excluded from capture; this class only decides
// what to show. No electrobun import: tests drive it with a fake binding.
//
// It never throws: a helper failure is logged once and the frame is dropped (Live keeps
// running without it), as ARCHITECTURE.md §6 asks.
import type { Display, Logger, Rect } from "@glimpse/core";
import { type FrameHandle, type FrameNativeBinding, type FrameSpace, rgbaOf } from "../../native/frame.ts";
import { FRAME_COLORS, type FrameTag, frameTagText, pinnedFrameLayout } from "./frame-layout.ts";

export interface PinnedFrameOptions {
	readonly binding: FrameNativeBinding | null;
	readonly space: FrameSpace;
	/** Why there is no binding (diagnostics). */
	readonly status?: string;
	readonly displays: () => readonly Display[];
	/** Register the frame's native window id with capture exclusion (macOS SCK fallback). Returns an unregister. */
	readonly exclude?: (windowId: number) => () => void;
	readonly log: Pick<Logger, "info" | "warn" | "debug">;
	/** Override the DESIGN.md accent (the OS accent colour, when the shell reports one). */
	readonly accent?: () => string | null;
}

export interface PinnedFrameState {
	readonly region: Rect | null;
	readonly visible: boolean;
	readonly paused: boolean;
	readonly tag: FrameTag;
	readonly tagBelow: boolean;
	readonly highlight: Rect | null;
}

export class PinnedFrame {
	readonly #o: PinnedFrameOptions;
	#handle: FrameHandle | null = null;
	#broken = false;
	#unexclude: (() => void) | null = null;
	#state: PinnedFrameState = {
		region: null,
		visible: false,
		paused: false,
		tag: { kind: "none" },
		tagBelow: false,
		highlight: null,
	};

	constructor(options: PinnedFrameOptions) {
		this.#o = options;
	}

	/** A native frame can be drawn (false on Linux, or when the helper is missing or failed). */
	get available(): boolean {
		return this.#o.binding !== null && !this.#broken;
	}

	get state(): PinnedFrameState {
		return this.#state;
	}

	/** Pin (or re-pin) to `region` (global logical) and show it. */
	show(region: Rect): void {
		this.#state = { ...this.#state, region, visible: true };
		this.#apply(true);
	}

	hide(): void {
		if (!this.#state.visible) return;
		this.#state = { ...this.#state, visible: false };
		this.#call("hide", (b, h) => b.frameShow(h, false));
	}

	/** Running: accent ticks. Paused / error: picker-stroke at 60 %. */
	setPaused(paused: boolean): void {
		if (paused === this.#state.paused) return;
		this.#state = { ...this.#state, paused };
		this.#apply(false);
	}

	/** The region tag: only while the Live popup is hidden (live-popup.md §2.4). */
	setTag(tag: FrameTag): void {
		if (JSON.stringify(tag) === JSON.stringify(this.#state.tag)) return;
		this.#state = { ...this.#state, tag };
		this.#apply(true);
	}

	/** The linked block's box (global logical), or null. */
	setHighlight(box: Rect | null): void {
		this.#state = { ...this.#state, highlight: box };
		if (!this.#handle) return;
		const mapped = box ? this.#o.space(box) : null;
		this.#call("highlight", (b, h) => b.frameSetHighlight(h, mapped?.rect ?? null));
	}

	dispose(): void {
		const handle = this.#handle;
		this.#handle = null;
		this.#unexclude?.();
		this.#unexclude = null;
		this.#state = { ...this.#state, visible: false, region: null, highlight: null };
		if (handle !== null && this.#o.binding) {
			try {
				this.#o.binding.frameDestroy(handle);
			} catch (error) {
				this.#o.log.warn("live frame: destroy failed", { error });
			}
		}
	}

	#apply(geometry: boolean): void {
		const { region } = this.#state;
		if (!region || !this.#o.binding || this.#broken) return;
		const display = this.#displayOf(region);
		const hasTag = this.#state.tag.kind !== "none";
		const layout = pinnedFrameLayout(region, { tag: hasTag, displayTop: display?.bounds.y ?? region.y - 100 });
		this.#state = { ...this.#state, tagBelow: layout.tagBelow };
		if (this.#handle === null) {
			const created = this.#call("create", (b) => b.frameCreate());
			if (!created) return;
			this.#handle = created.value;
		}
		const palette = this.#palette();
		const tag = this.#state.tag;
		const ok = this.#call("style", (b, h) =>
			b.frameSetStyle(h, {
				paused: this.#state.paused,
				palette,
				tag: tag.kind === "none" ? 0 : tag.kind === "live" ? 1 : tag.kind === "paused" ? 2 : 3,
				tagText: frameTagText(tag),
				tagBelow: layout.tagBelow,
			}),
		);
		if (!ok) return;
		if (geometry) {
			const mapped = this.#o.space(region);
			if (!mapped) {
				this.#o.log.warn("live frame: the region is on no display; frame hidden");
				this.#call("hide", (b, h) => b.frameShow(h, false));
				return;
			}
			if (!this.#call("rect", (b, h) => b.frameSetRect(h, mapped.rect, mapped.scale))) return;
		}
		if (this.#state.visible) {
			if (!this.#call("show", (b, h) => b.frameShow(h, true))) return;
			this.#registerExclusion();
		}
	}

	#registerExclusion(): void {
		if (this.#unexclude || !this.#o.exclude) return;
		const id = this.#call("window id", (b, h) => b.frameWindowId(h));
		if (id && id.value > 0) this.#unexclude = this.#o.exclude(id.value);
	}

	#palette(): Uint32Array {
		const accent = this.#o.accent?.() ?? FRAME_COLORS.accent;
		return Uint32Array.of(
			rgbaOf(accent),
			rgbaOf(FRAME_COLORS["picker-halo"]),
			rgbaOf(FRAME_COLORS["picker-stroke"]),
			rgbaOf(FRAME_COLORS["picker-hud"]),
			rgbaOf(FRAME_COLORS["picker-hud-text"]),
			rgbaOf(FRAME_COLORS["box-linked-fill"]),
			rgbaOf(FRAME_COLORS["egress-dark"]),
		);
	}

	#displayOf(region: Rect): Display | undefined {
		const displays = this.#o.displays();
		const cx = region.x + region.width / 2;
		const cy = region.y + region.height / 2;
		return (
			displays.find(
				(d) =>
					region.x >= d.bounds.x &&
					region.y >= d.bounds.y &&
					region.x < d.bounds.x + d.bounds.width &&
					region.y < d.bounds.y + d.bounds.height,
			) ??
			displays.find(
				(d) =>
					cx >= d.bounds.x && cy >= d.bounds.y && cx < d.bounds.x + d.bounds.width && cy < d.bounds.y + d.bounds.height,
			)
		);
	}

	/** Run a helper call; on failure log once, drop the frame and return null. */
	#call<T>(what: string, run: (b: FrameNativeBinding, h: FrameHandle) => T): { readonly value: T } | null {
		const b = this.#o.binding;
		if (!b || this.#broken) return null;
		try {
			return { value: run(b, this.#handle ?? 0n) };
		} catch (error) {
			this.#broken = true;
			this.#o.log.warn(`live frame: ${what} failed; Live continues without the on-screen frame`, { error });
			const handle = this.#handle;
			this.#handle = null;
			if (handle !== null) {
				try {
					b.frameDestroy(handle);
				} catch {
					// already logged
				}
			}
			return null;
		}
	}
}
