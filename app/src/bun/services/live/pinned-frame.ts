// The on-screen frame around a pinned Live region (GLIM-90; live-popup.md §2.4, §12.2):
// corner ticks outside the region, accent while running and grey while paused, the region tag
// while the popup is hidden, and the linked-block highlight. Drawn by the native helper in a
// click-through, always-on-top window that is excluded from capture; this class only decides
// what to show. No electrobun import: tests drive it with a fake binding.
//
// It never throws: a helper failure is logged once and the frame is dropped (Live keeps
// running without it), as ARCHITECTURE.md §6 asks.
import { type Display, LIVE_CARD_PEEK_OPACITY, type Logger, type Rect } from "@glimpse/core";
import type { LiveMarksUnavailable } from "../../../shared/live-rpc.ts";
import {
	type FrameHandle,
	type FrameNativeBinding,
	type FrameSpace,
	type FrameSprite,
	premultiplied,
	rgbaOf,
	SPRITE_INTERACTIVE,
	SPRITE_PEEK,
} from "../../native/frame.ts";
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
	/** Clock for re-checking a negative capture-exclusion result (GLIM-163). Default: Date.now. */
	readonly now?: () => number;
}

/**
 * GLIM-154: one numbered badge or overlay card, rasterised by the Live view, in global logical
 * px. `id` is its block's id (clicks and hovers report it back).
 */
export interface LiveFrameMark {
	readonly id: string;
	readonly kind: "badge" | "card";
	readonly rect: Rect;
	/** Bitmap size in pixels (the rect times the display scale). */
	readonly width: number;
	readonly height: number;
	/** Straight-alpha RGBA, `width * height * 4` bytes. */
	readonly rgba: Uint8Array;
	readonly opacity: number;
}

/** What the pointer did over the marks since the last poll (block ids). */
export interface LiveMarksPointer {
	readonly hover: string | null;
	readonly click: string | null;
}

/** WDA_EXCLUDEFROMCAPTURE, as GetWindowDisplayAffinity reads it back. */
const WDA_EXCLUDEFROMCAPTURE = 0x11;

/**
 * GLIM-163: a frame not (yet) confirmed out of capture is asked again, at most this often,
 * when Live next asks whether marks can be drawn (and always on show / re-pin). A confirmed
 * frame stays confirmed.
 */
export const MARKS_RECHECK_MS = 2000;

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
	/** GLIM-154: the marks on screen, in sprite order (pointer indices map back to them). */
	#marks: readonly LiveFrameMark[] = [];
	/**
	 * Whether the frame window is confirmed out of capture (null: not checked yet). Only
	 * `true` is final; `false` is asked again after MARKS_RECHECK_MS or on show (GLIM-163).
	 */
	#excluded: boolean | null = null;
	#checkedAt = 0;
	/** GLIM-163: the last "no marks" reason logged, so each one is logged once. */
	#loggedReason: string | null = null;
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
		// GLIM-163: a negative check may have been a timing miss; ask again once shown.
		if (this.#excluded === false) this.#excluded = null;
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

	/**
	 * GLIM-154: badges and cards can be drawn: a native frame with sprite support whose window
	 * is confirmed out of Glimpse's own capture. Windows reads the display affinity back (it
	 * is WDA_NONE before build 19041, where the cards would be OCR'd); on macOS the SCK filter
	 * leaves out the whole app, and the frame's window id is registered as a fallback. With no
	 * confirmation, no marks: Live must never read its own cards.
	 */
	get marksAvailable(): boolean {
		return this.marksUnavailable === null;
	}

	/**
	 * GLIM-163: why badges and cards can't be drawn (null when they can). The popup shows its
	 * On screen toggle disabled with this reason; each distinct detail is logged once.
	 */
	get marksUnavailable(): LiveMarksUnavailable | null {
		const b = this.#o.binding;
		if (!b) return this.#unavailable("no-frame", `no frame binding (${this.#o.status ?? "unknown"})`);
		if (this.#broken) return this.#unavailable("no-frame", "the frame helper failed");
		if (!b.frameSetSprites) return this.#unavailable("no-frame", "the frame helper has no sprite support");
		if (this.#handle === null) return this.#unavailable("no-frame", "no frame window yet");
		const now = this.#now();
		if (this.#excluded === null || (this.#excluded === false && now - this.#checkedAt >= MARKS_RECHECK_MS)) {
			const check = this.#checkExcluded();
			this.#excluded = check.excluded;
			this.#checkedAt = now;
			if (!check.excluded) return this.#unavailable("not-excluded", check.why);
			if (this.#loggedReason !== null) {
				this.#o.log.info("live frame: confirmed out of capture; numbered marks and overlay cards are on");
				this.#loggedReason = null;
			}
		}
		return this.#excluded ? null : "not-excluded";
	}

	/** The region's display scale (sprite pixels per logical px), or null without marks. */
	get marksScale(): number | null {
		const region = this.#state.region;
		if (!region || !this.marksAvailable) return null;
		return this.#displayOf(region)?.scaleFactor ?? 1;
	}

	/** Replace the badges and cards (an empty list clears them). Ignored without marks. */
	setMarks(marks: readonly LiveFrameMark[]): void {
		if (marks.length === 0 && this.#marks.length === 0) return;
		if (marks.length > 0 && !this.marksAvailable) return;
		const sprites: FrameSprite[] = [];
		const kept: LiveFrameMark[] = [];
		for (const m of marks) {
			const mapped = this.#o.space(m.rect);
			if (!mapped || m.width <= 0 || m.height <= 0 || m.rgba.length < m.width * m.height * 4) continue;
			sprites.push({
				rect: mapped.rect,
				width: m.width,
				height: m.height,
				rgba: premultiplied(m.rgba),
				opacity: m.opacity,
				// Badges and cards pick their block; a card under the pointer peeks.
				flags: SPRITE_INTERACTIVE | (m.kind === "card" ? SPRITE_PEEK : 0),
			});
			kept.push(m);
		}
		const ok = this.#call("marks", (b, h) => b.frameSetSprites?.(h, sprites, LIVE_CARD_PEEK_OPACITY));
		this.#marks = ok ? kept : [];
	}

	get marks(): readonly LiveFrameMark[] {
		return this.#marks;
	}

	/** The block under the pointer on screen, and the one clicked since the last poll. */
	pointer(): LiveMarksPointer {
		if (this.#marks.length === 0 || !this.#o.binding?.framePointer || this.#handle === null) {
			return { hover: null, click: null };
		}
		const p = this.#call("pointer", (b, h) => b.framePointer?.(h) ?? { hover: -1, click: -1 });
		const idOf = (i: number) => (i >= 0 ? (this.#marks[i]?.id ?? null) : null);
		return p ? { hover: idOf(p.value.hover), click: idOf(p.value.click) } : { hover: null, click: null };
	}

	#checkExcluded(): { readonly excluded: boolean; readonly why: string } {
		const h = this.#handle;
		const b = this.#o.binding;
		if (h === null || !b) return { excluded: false, why: "no frame window" };
		let info: Record<string, number> | null = null;
		let error: unknown = null;
		try {
			info = b.frameInfo(h);
		} catch (e) {
			error = e;
		}
		if (!info) {
			const detail = error === null ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
			return { excluded: false, why: `frame_info returned nothing${detail}` };
		}
		const affinity = info["affinity"];
		if (typeof affinity === "number") {
			if (affinity === WDA_EXCLUDEFROMCAPTURE) return { excluded: true, why: "" };
			const err = info["affinityError"];
			const setError = typeof err === "number" && err !== 0 ? `; SetWindowDisplayAffinity error ${err}` : "";
			return {
				excluded: false,
				why: `display affinity reads back 0x${affinity.toString(16)}, not WDA_EXCLUDEFROMCAPTURE (0x11)${setError}`,
			};
		}
		// macOS: the SCK filter leaves out the whole app; a sharingType means the panel exists.
		if (typeof info["sharingType"] === "number") return { excluded: true, why: "" };
		return { excluded: false, why: `frame_info has no affinity or sharingType (${Object.keys(info).join(",")})` };
	}

	/** Log each distinct reason once (info level, so Copy diagnostics has it), then return `kind`. */
	#unavailable(kind: LiveMarksUnavailable, why: string): LiveMarksUnavailable {
		if (this.#loggedReason !== why) {
			this.#loggedReason = why;
			this.#o.log.info("live frame: numbered marks and overlay cards are off", { reason: kind, why });
		}
		return kind;
	}

	#now(): number {
		return this.#o.now?.() ?? Date.now();
	}

	dispose(): void {
		this.#marks = [];
		this.#excluded = null;
		this.#checkedAt = 0;
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
