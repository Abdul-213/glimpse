// The docked Live popup view (GLIM-79; live-popup.md §2, §4, §7, §9, §10). Renders the state
// main pushes (`LiveStateMessage`) and sends intents back.
//
// In-place updates: the state is reconciled into a store keyed by block id, so a frame that
// changes one block re-renders that block only; the others keep their DOM nodes (and their
// running flash animations). A block's `changeId` restarts its flash → rest tint and moves the
// mark (TextBlock); reduced motion shows the resting tint and the mark at once (CSS).
//
// Moving (GLIM-151, §3.3): the strip is the drag handle (pointer events → main, at most one
// move per animation frame; main moves the window without activating it), double-click on it
// docks, Alt/Option+arrows move the focused popup. Pin and Dock sit with the window controls.
import {
	badgeLabel,
	downloadNeedsConfirm,
	facingEdge,
	type LanguageCode,
	type LivePopupBlock,
	type LivePopupState,
	listedLiveBlocks,
	liveMarks,
	liveShowsEmpty,
	liveStrip,
	skippedLiveBlocks,
	stripLayout,
} from "@glimpse/core";
import {
	BlockList,
	Button,
	EgressBadge,
	Icon,
	IconButton,
	LocalIndicator,
	languageName,
	PackRows,
	PopupShell,
	SkippedLine,
	StateMessage,
	StatusIndicator,
	TextBlock,
	TextButton,
	Toolbar,
} from "@glimpse/ui";
import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type {
	LiveConsentAnswer,
	LiveMarkSprite,
	LiveMoveDirection,
	LiveSkippedAction,
	LiveStateMessage,
	LiveViewInit,
} from "../../shared/live-rpc.ts";
import {
	COPY,
	company,
	consentCopy,
	egressTooltip,
	errorCopy,
	type LiveErrorAction,
	moveHint,
	packConfirmCancel,
	packConfirmText,
	packDownloadText,
	packFailedText,
	packOfflineText,
	packProgressLabel,
	packProgressText,
	packRowText,
	pauseLabel,
	staleText,
	statusLabel,
} from "./copy.ts";
import { liveKey, liveMoveKey } from "./keys.ts";
import { cardTypeFor, type MarkTheme, measureText, planMarks, readMarkTheme, spriteMessages } from "./marks.ts";

export interface LivePopupIntents {
	painted(sessionId: string): void;
	resized(sessionId: string, contentHeight: number): void;
	pause(sessionId: string): void;
	resume(sessionId: string): void;
	stop(sessionId: string): void;
	repin(sessionId: string): void;
	setPrivate(sessionId: string, on: boolean): void;
	consent(sessionId: string, answer: LiveConsentAnswer, remember: boolean): void;
	hoverBlock(sessionId: string, id: string | null): void;
	pointerEntered(sessionId: string): void;
	blurred(sessionId: string): void;
	copy(sessionId: string, what: "translation" | "original"): void;
	skipped(sessionId: string, expanded: boolean): void;
	/** L12: the pack row's Download (GLIM-123). Optional: previews may omit it. */
	downloadPack?(sessionId: string, lang: string): void;
	/** The spend guard's "Continue this month" (GLIM-120). Optional: previews may omit it. */
	continueCloud?(sessionId: string): void;
	/** GLIM-131: the skipped line's "Translate these" / "Edit source languages…". */
	skippedAction?(sessionId: string, action: LiveSkippedAction): void;
	/** GLIM-151: drag on the strip (screen deltas since pointer-down). Optional: previews may omit them. */
	dragStart?(sessionId: string): void;
	dragMove?(sessionId: string, dx: number, dy: number): void;
	dragEnd?(sessionId: string): void;
	/** Alt/Option+arrows. */
	move?(sessionId: string, direction: LiveMoveDirection, large: boolean): void;
	/** Dock button, double-click on the strip. */
	dock?(sessionId: string): void;
	/** The Pin toggle. */
	setPinned?(sessionId: string, on: boolean): void;
	/** GLIM-154: overlay mode on / off. */
	overlay?(sessionId: string, on: boolean): void;
	/** GLIM-154: the badges and cards for the pinned frame (bitmaps for new keys only). */
	marks?(sessionId: string, sprites: LiveMarkSprite[]): void;
}

/** Pointer travel before a press on the strip becomes a drag (a click or double-click stays one). */
const DRAG_SLOP_PX = 3;

const onControl = (target: EventTarget | null) =>
	target instanceof Element && target.closest("button, input, a, [role='button']") !== null;

export interface LivePopupProps {
	init: LiveViewInit;
	message: LiveStateMessage;
	intents: LivePopupIntents;
	/** Frame scheduler (screenshots can pass a synchronous one). */
	raf?: (cb: () => void) => void;
	/** Delay before reporting a smaller height, so removed blocks animate first (§9). */
	shrinkDelayMs?: number;
	/**
	 * GLIM-92: the last announcements main sent (at most 5). `change` entries fill the polite
	 * `role="log"`, the latest `status` the `role="status"` region.
	 */
	announcements?: readonly LiveAnnouncement[];
}

export interface LiveAnnouncement {
	readonly id: number;
	readonly text: string;
	readonly kind: "change" | "status";
}

/** Shrinking waits for the content animation (~220 ms, §9 Window resize). */
const SHRINK_AFTER_MS = 220;

export function LivePopup(props: LivePopupProps): JSX.Element {
	const raf = (cb: () => void) => (props.raf ?? ((f) => requestAnimationFrame(() => f())))(cb);
	const [store, setStore] = createStore<{ s: LivePopupState }>({ s: props.message.state });
	createEffect(
		on(
			() => props.message.state,
			(s) => setStore("s", reconcile(s, { key: "id", merge: true })),
		),
	);
	const state = () => store.s;
	const id = () => props.message.sessionId;
	const uiLang = () => props.init.uiLang;
	let shell: HTMLDivElement | undefined;
	let list: HTMLUListElement | undefined;
	let pauseBtn: HTMLButtonElement | undefined;
	const [entering, setEntering] = createSignal(false);
	const [hovered, setHovered] = createSignal<string | null>(null);
	const [pointerInside, setPointerInside] = createSignal(false);

	// A new session: reset scroll, play the enter animation, report `painted` after two frames.
	createEffect(
		on(id, (sessionId) => {
			if (list) list.scrollTop = 0;
			setEntering(false);
			raf(() => {
				setEntering(true);
				raf(() => props.intents.painted(sessionId));
			});
		}),
	);

	// Natural content height; growing is reported at once, shrinking after the animation.
	let measureQueued = false;
	let lastHeight = 0;
	let shrinkTimer: ReturnType<typeof setTimeout> | null = null;
	const report = (h: number) => {
		lastHeight = h;
		props.intents.resized(id(), h);
	};
	const measure = () => {
		if (measureQueued) return;
		measureQueued = true;
		raf(() => {
			measureQueued = false;
			if (!shell || !list) return;
			const chrome = shell.offsetHeight - list.clientHeight;
			const natural = Math.ceil(list.scrollHeight + chrome);
			if (shrinkTimer) clearTimeout(shrinkTimer);
			shrinkTimer = null;
			const delay = props.message.reducedMotion ? 0 : (props.shrinkDelayMs ?? SHRINK_AFTER_MS);
			if (natural >= lastHeight || delay === 0) report(natural);
			else shrinkTimer = setTimeout(() => report(natural), delay);
		});
	};
	createEffect(() => {
		props.message.state;
		measure();
	});
	if (typeof ResizeObserver !== "undefined") {
		const ro = new ResizeObserver(() => measure());
		queueMicrotask(() => {
			if (shell) ro.observe(shell);
			if (list) ro.observe(list);
		});
		onCleanup(() => ro.disconnect());
	}
	onCleanup(() => {
		if (shrinkTimer) clearTimeout(shrinkTimer);
	});

	// §4 L20: a changed block outside the visible scroll area comes into view, unless the
	// pointer is over the popup or it has keyboard focus.
	createEffect(
		on(
			() => state().changeSeq,
			() => {
				if (pointerInside() || shell?.contains(document.activeElement)) return;
				raf(() => {
					const el = list?.querySelector<HTMLElement>(".glim-change-mark")?.closest<HTMLElement>("[data-block]");
					el?.scrollIntoView?.({ block: "nearest", behavior: props.message.reducedMotion ? "auto" : "smooth" });
				});
			},
			{ defer: true },
		),
	);

	const strip = () => liveStrip(state());
	const layout = () => stripLayout(props.message.layout.width);
	const paused = () => state().status === "paused" || state().status === "error";
	const cloud = () => state().providers.cloud;
	const consent = () => (state().status === "consent" ? consentCopy(state()) : null);
	const error = () =>
		state().status === "error" && state().error
			? errorCopy(state().error as NonNullable<LivePopupState["error"]>)
			: null;
	const [remember, setRemember] = createSignal(false);

	const act = (a: LiveErrorAction) => {
		if (a === "resume") props.intents.resume(id());
		else if (a === "repin") props.intents.repin(id());
		else if (a === "continueCloud") props.intents.continueCloud?.(id());
		else props.intents.stop(id());
	};
	const togglePause = () => (paused() ? props.intents.resume(id()) : props.intents.pause(id()));
	const hover = (blockId: string, on: boolean) => {
		const next = on ? blockId : hovered() === blockId ? null : hovered();
		if (next === hovered()) return;
		setHovered(next);
		props.intents.hoverBlock(id(), next);
	};

	// Consent and Focus Live popup hand the keyboard over on purpose (§7.3, §7.4).
	let stateRow: HTMLDivElement | undefined;
	createEffect(
		on(
			() => props.message.focused,
			(focused) => {
				if (!focused) return;
				raf(() => (stateRow?.querySelector<HTMLElement>("button") ?? pauseBtn)?.focus({ preventScroll: true }));
			},
		),
	);

	// Original view (Ctrl/⌘⇧O): how this window renders blocks, not session state.
	const [original, setOriginal] = createSignal(false);

	// GLIM-154: numbered markers and the overlay over the pinned region (§2.6). The numbers
	// show only when the frame draws badges (two or more numbered blocks, frame out of capture).
	const marksOn = () => !!props.message.marks && state().status !== "consent";
	const marks = createMemo(() =>
		marksOn()
			? liveMarks(state(), {
					linkedId: hovered(),
					// The target arrives as a plain string over RPC; core's codes are branded.
					target: (props.message.marks?.target ?? null) as LanguageCode | null,
				})
			: null,
	);
	const numbered = () => (marks()?.badges.length ?? 0) > 0;
	const numberOf = (b: LivePopupBlock) =>
		numbered() && b.badge !== undefined ? badgeLabel(b.badge, uiLang()) : undefined;
	const overlayOn = () => state().overlay;
	const setOverlay = (on: boolean) => props.intents.overlay?.(id(), on);
	// A badge or card clicked on screen: its block scrolls into view and stays highlighted. The
	// popup never takes focus for it (the game keeps the keyboard, §7).
	createEffect(
		on(
			() => state().selected?.seq,
			() => {
				const picked = state().selected;
				if (!picked) return;
				raf(() => {
					const el = shell?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(picked.id)}"]`);
					el?.scrollIntoView?.({ block: "nearest" });
				});
			},
			{ defer: true },
		),
	);
	// Rasterise the marks and hand them to main; only marks whose look changed are drawn again.
	let sentFor: string | null = null;
	const sent = new Set<string>();
	let theme: MarkTheme | null = null;
	let lastCount = 0;
	createEffect(() => {
		const m = marks();
		const cfg = props.message.marks;
		const region = state().region;
		const peekAll = original();
		const sessionId = id();
		if (!props.intents.marks || typeof document === "undefined") return;
		if (sentFor !== sessionId) {
			sentFor = sessionId;
			sent.clear();
			lastCount = 0;
		}
		if (!m || !cfg || !region) {
			if (lastCount > 0) props.intents.marks(sessionId, []);
			lastCount = 0;
			sent.clear();
			return;
		}
		theme = readMarkTheme();
		const planned = planMarks(m, {
			region,
			uiDir: props.init.uiDir,
			uiLang: uiLang(),
			scale: cfg.scale,
			peekAll,
			theme,
			cardType: cardTypeFor,
			measure: measureText,
		});
		if (planned.length === 0 && lastCount === 0) return;
		lastCount = planned.length;
		props.intents.marks(sessionId, spriteMessages(planned, cfg.scale, sent));
	});
	const onKeyDown = (e: KeyboardEvent) => {
		const key = liveKey(e, props.init.os === "macos");
		if (!key) {
			if (e.key === "Tab" && shell) trapTab(shell, e);
			return;
		}
		if (key === "copy" && hasSelection(shell)) return; // the selection copies the normal way
		e.preventDefault();
		switch (key) {
			case "escape":
				if (state().status === "consent") props.intents.consent(id(), "cancel", false);
				else props.intents.blurred(id());
				break;
			case "pause":
				if (state().status !== "consent") togglePause();
				break;
			case "stop":
				if (state().status === "consent") props.intents.consent(id(), "cancel", false);
				else props.intents.stop(id());
				break;
			case "copy":
				props.intents.copy(id(), "translation");
				break;
			case "copyOriginal":
				props.intents.copy(id(), "original");
				break;
			case "original":
				setOriginal(!original());
				break;
			case "overlay":
				if (marksOn()) setOverlay(!overlayOn());
				break;
		}
	};

	// GLIM-151: drag the strip. Pointer capture keeps the moves coming while the window
	// catches up with the pointer; main follows the OS cursor, the deltas are a fallback.
	const moved = () => !!props.message.layout.moved;
	const pinned = () => props.message.layout.pinned !== false;
	const [dragging, setDragging] = createSignal(false);
	let press: { id: number; x: number; y: number } | null = null;
	let pending: { dx: number; dy: number } | null = null;
	const flushMove = () => {
		if (!pending) return;
		const { dx, dy } = pending;
		pending = null;
		props.intents.dragMove?.(id(), dx, dy);
	};
	const onStripDown = (e: PointerEvent) => {
		if (e.button !== 0 || onControl(e.target) || !props.intents.dragStart) return;
		press = { id: e.pointerId, x: e.screenX, y: e.screenY };
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		props.intents.dragStart(id());
	};
	const onStripMove = (e: PointerEvent) => {
		if (!press || e.pointerId !== press.id) return;
		const dx = e.screenX - press.x;
		const dy = e.screenY - press.y;
		if (!dragging()) {
			if (Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
			setDragging(true);
		}
		const first = pending === null;
		pending = { dx, dy };
		if (first) raf(flushMove);
	};
	const onStripUp = (e: PointerEvent) => {
		if (!press || e.pointerId !== press.id) return;
		press = null;
		flushMove();
		setDragging(false);
		props.intents.dragEnd?.(id());
	};
	const onStripDoubleClick = (e: MouseEvent) => {
		if (!onControl(e.target) && moved()) props.intents.dock?.(id());
	};
	// Alt/Option+arrows, before the toolbar's and block list's own arrow keys see them.
	const onMoveKey = (e: KeyboardEvent) => {
		const k = liveMoveKey(e);
		if (!k || !props.intents.move) return;
		e.preventDefault();
		e.stopPropagation();
		props.intents.move(id(), k.direction, k.large);
	};
	onMount(() => {
		shell?.addEventListener("keydown", onMoveKey, true);
		onCleanup(() => shell?.removeEventListener("keydown", onMoveKey, true));
	});
	const hintId = `live-move-hint-${Math.random().toString(36).slice(2, 8)}`;

	return (
		<PopupShell
			kind="live"
			ref={shell}
			dir={props.init.uiDir}
			lang={uiLang()}
			facing={facingEdge(props.message.layout.side)}
			entering={entering() && !props.message.reducedMotion}
			aria-label={COPY.region}
			aria-describedby={hintId}
			class="live-popup"
			data-moved={moved() ? "" : undefined}
			data-dragging={dragging() ? "" : undefined}
			data-layout={layout()}
			data-stale={state().stale ? "" : undefined}
			onKeyDown={onKeyDown}
			onPointerEnter={() => {
				setPointerInside(true);
				props.intents.pointerEntered(id());
			}}
			onPointerLeave={() => setPointerInside(false)}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only drag handle; keyboard users move the popup with Alt/Option+arrows (described on the popup) and dock with the Dock button. */}
			<div
				class="live-strip"
				onPointerDown={onStripDown}
				onPointerMove={onStripMove}
				onPointerUp={onStripUp}
				onPointerCancel={onStripUp}
				onLostPointerCapture={onStripUp}
				onDblClick={onStripDoubleClick}
			>
				<span class="live-grip" aria-hidden="true">
					<Icon name="grip" size={12} />
				</span>
				<StatusIndicator
					status={strip().dot}
					label={statusLabel(
						strip().label,
						state().private,
						// GLIM-154: with the overlay toggle, " · Private" needs a wide strip (the pressed toggle still says it).
						layout() === "compact" || (marksOn() && layout() === "regular"),
					)}
				/>
				<Show when={!cloud()}>
					<LocalIndicator label={COPY.local} tooltip={COPY.localTooltip} compact={layout() !== "wide"} />
				</Show>
				<span class="live-spacer" />
				<Toolbar label={COPY.controls} class="live-controls">
					{/* L10: until the question is answered only Stop (= cancel) is offered. */}
					<Show when={state().status !== "consent"}>
						<IconButton
							icon="eye-off"
							label={state().private ? COPY.privateOn : COPY.privateOff}
							pressed={state().private}
							onClick={() => props.intents.setPrivate(id(), !state().private)}
						/>
						<IconButton
							ref={pauseBtn}
							icon={paused() ? "play" : "pause"}
							label={pauseLabel(paused())}
							shortcut={props.init.keys.pause}
							pressed={paused()}
							onClick={togglePause}
						/>
						<IconButton icon="select-area" label={COPY.repin} onClick={() => props.intents.repin(id())} />
					</Show>
					{/* GLIM-154: overlay mode, when the frame can paint cards out of capture. */}
					<Show when={marksOn()}>
						<IconButton
							icon="on-screen"
							label={overlayOn() ? COPY.hideFromScreen : COPY.showOnScreen}
							shortcut={props.init.keys.overlay}
							pressed={overlayOn()}
							onClick={() => setOverlay(!overlayOn())}
						/>
					</Show>
					{/* GLIM-151: window controls. Dock only once moved; Pin is a toggle (on = on top). */}
					<Show when={moved()}>
						<IconButton icon="magnet" label={COPY.dock} onClick={() => props.intents.dock?.(id())} />
					</Show>
					<IconButton
						icon={pinned() ? "pin" : "pin-off"}
						label={COPY.pin}
						pressed={pinned()}
						onClick={() => props.intents.setPinned?.(id(), !pinned())}
					/>
					<IconButton
						icon="stop"
						label={COPY.stop}
						shortcut={props.init.keys.stop}
						onClick={() =>
							state().status === "consent" ? props.intents.consent(id(), "cancel", false) : props.intents.stop(id())
						}
					/>
				</Toolbar>
			</div>
			<Show when={state().status !== "consent" ? cloud() : null}>
				{(p) => (
					<div class="live-cloud-row">
						<EgressBadge
							provider={p().name}
							shortName={company(p().name)}
							short={layout() === "compact"}
							tooltip={egressTooltip(p().name)}
						/>
					</div>
				)}
			</Show>
			<div class="live-state-row" ref={stateRow}>
				<Show when={consent()}>
					{(c) => (
						<StateMessage
							title={c().title}
							actions={
								<>
									<Button variant="primary" onClick={() => props.intents.consent(id(), "cloud", remember())}>
										{c().primary}
									</Button>
									<Show when={state().consent?.localAvailable}>
										<Button variant="secondary" onClick={() => props.intents.consent(id(), "local", false)}>
											{COPY.consentLocal}
										</Button>
									</Show>
									<Button variant="secondary" onClick={() => props.intents.consent(id(), "cancel", false)}>
										{COPY.consentCancel}
									</Button>
								</>
							}
						>
							{c().body}
						</StateMessage>
					)}
				</Show>
				<Show when={state().consent?.canRemember && state().status === "consent"}>
					<label class="live-remember">
						<input type="checkbox" checked={remember()} onChange={(e) => setRemember(e.currentTarget.checked)} />
						{COPY.consentRemember}
					</label>
				</Show>
				<Show when={error()}>
					{(e) => (
						<StateMessage
							title={e().title}
							tone="danger"
							actions={
								<For each={e().actions}>
									{(a) => (
										<Button variant={a.primary ? "primary" : "secondary"} onClick={() => act(a.action)}>
											{a.label}
										</Button>
									)}
								</For>
							}
						>
							{e().body}
						</StateMessage>
					)}
				</Show>
				<Show when={state().status === "paused" && state().capturedAt !== null}>
					<p class="live-quiet">
						{state().reason === "locked" || state().reason === "sleep"
							? COPY.locked
							: staleText(state().capturedAt ?? 0, props.message.now)}
					</p>
				</Show>
				<Show when={liveShowsEmpty(state())}>
					<p class="live-quiet">{COPY.empty}</p>
				</Show>
			</div>
			{/* L12 (GLIM-123): one row per missing language at the top of the list; those blocks
			    show their source text, the rest translate and the session keeps running. */}
			<Show when={state().status !== "consent" && state().packs.length > 0}>
				<PackRows
					class="live-packs"
					rows={state().packs}
					text={(row) => packRowText(row.lang, uiLang(), row.kind)}
					downloadLabel={(row) => packDownloadText(row.bytes)}
					offlineText={packOfflineText}
					failedText={packFailedText}
					progressLabel={(row) => packProgressLabel(row.lang, uiLang(), row.kind)}
					progressText={packProgressText}
					needsConfirm={downloadNeedsConfirm}
					confirmText={(row) => packConfirmText(row, uiLang())}
					cancelLabel={packConfirmCancel}
					onDownload={(row) => props.intents.downloadPack?.(id(), row.lang)}
				/>
			</Show>
			<BlockList ref={(el) => (list = el)} aria-label={COPY.list} class="live-list">
				<Show when={state().status !== "consent"}>
					<For each={listedLiveBlocks(state())}>
						{(b) => (
							<LiveTextBlock
								block={b}
								stale={state().stale}
								original={original()}
								marked={b.changeId !== null && b.changeId === state().changeSeq}
								linked={hovered() === b.id || state().screenLinked === b.id}
								selected={state().selected?.id === b.id}
								number={numberOf(b)}
								onLink={(on) => hover(b.id, on)}
							/>
						)}
					</For>
					{/* GLIM-82: blocks outside the source subset, never translated; the count and
					    languages update silently and the expansion persists for the session. */}
					<Show when={skippedLiveBlocks(state()).length > 0}>
						<SkippedLine
							count={skippedLiveBlocks(state()).length}
							languages={skippedLanguages(state()).map((l) => languageName(l, uiLang()))}
							uiLocale={uiLang()}
							expanded={state().skippedExpanded}
							onExpandedChange={(x) => props.intents.skipped(id(), x)}
						>
							<For each={skippedLiveBlocks(state())}>
								{(b) => (
									<TextBlock
										variant="live"
										state="done"
										kind="neutral"
										source={b.source}
										sourceLang={b.lang ?? undefined}
										tag={b.lang ? languageName(b.lang, uiLang()) : undefined}
										tagLang={uiLang()}
										stale={state().stale}
										blockId={b.id}
										number={numberOf(b)}
										linked={hovered() === b.id || state().screenLinked === b.id}
										selected={state().selected?.id === b.id}
										onLinkChange={(on) => hover(b.id, on)}
									/>
								)}
							</For>
							{/* GLIM-131: as Snip. "Translate these" lasts for this session only. */}
							<li class="live-skipped-actions">
								<TextButton onClick={() => props.intents.skippedAction?.(id(), "translateSkipped")}>
									{COPY.translateThese}
								</TextButton>
								<TextButton onClick={() => props.intents.skippedAction?.(id(), "editSources")}>
									{COPY.editSources}
								</TextButton>
							</li>
						</SkippedLine>
					</Show>
				</Show>
			</BlockList>
			<span id={hintId} class="sr-only">
				{moveHint(props.init.os === "macos")}
			</span>
			{/* §10: read while the popup has focus; main speaks through the OS otherwise. */}
			<div class="sr-only" role="log" aria-live="polite" aria-relevant="additions" aria-label={COPY.changesLog}>
				<For each={(props.announcements ?? []).filter((a) => a.kind === "change").slice(-5)}>
					{(a) => <p>{a.text}</p>}
				</For>
			</div>
			<span class="sr-only" role="status">
				{/* Keyed by id, so the same words twice ("Popup moved") are a new node and read again. */}
				<For each={(props.announcements ?? []).filter((a) => a.kind === "status").slice(-1)}>
					{(a) => <span>{a.text}</span>}
				</For>
			</span>
		</PopupShell>
	);
}

function LiveTextBlock(props: {
	block: LivePopupBlock;
	stale: boolean;
	marked: boolean;
	linked: boolean;
	selected?: boolean;
	number?: string | undefined;
	onLink: (on: boolean) => void;
	original: boolean;
}): JSX.Element {
	const b = () => props.block;
	const kind = () => (b().cls === "neutral" ? "neutral" : b().cls === "target" ? "target" : "translate");
	const view = () => {
		if (b().cls !== "translate") return "done";
		if (b().failed) return "failed";
		if (b().pending) return "pending";
		return b().translation === null ? "pending" : "done";
	};
	return (
		<TextBlock
			variant="live"
			state={view()}
			kind={kind()}
			translation={b().translation ?? undefined}
			view={props.original ? "original" : "translation"}
			source={b().pending && b().partial ? (b().partial ?? b().source) : b().source}
			sourceLang={b().lang ?? undefined}
			stale={props.stale}
			changeId={props.marked ? b().changeId : null}
			changedLabel={COPY.changed}
			failedLabel={COPY.failed}
			linked={props.linked}
			selected={props.selected}
			number={props.number}
			blockId={b().id}
			onLinkChange={props.onLink}
		/>
	);
}

function hasSelection(root: HTMLElement | undefined): boolean {
	const sel = typeof window !== "undefined" ? window.getSelection() : null;
	if (!sel || sel.isCollapsed || sel.toString().length === 0) return false;
	return !root || (sel.anchorNode !== null && root.contains(sel.anchorNode));
}

/** Strip buttons → state-row buttons → blocks, wrapping (§6.2 Tab). */
function trapTab(shell: HTMLElement, e: KeyboardEvent): void {
	const stops = [...shell.querySelectorAll<HTMLElement>("button, input, [data-block], [data-roving]")].filter(
		(el) => !el.hasAttribute("disabled") && (el.tabIndex >= 0 || el.matches("[data-block], [data-roving]")),
	);
	const blocks = stops.filter((el) => el.matches("[data-block], [data-roving]"));
	const controls = stops.filter((el) => !blocks.includes(el));
	const order = blocks.length > 0 ? [...controls, blocks[0] as HTMLElement] : controls;
	if (order.length === 0) return;
	const active = document.activeElement as HTMLElement | null;
	const inBlocks = !!active && blocks.includes(active);
	const at = inBlocks ? order.length - 1 : order.indexOf(active as HTMLElement);
	const next = e.shiftKey ? (at <= 0 ? order.length - 1 : at - 1) : at < 0 || at >= order.length - 1 ? 0 : at + 1;
	e.preventDefault();
	order[next]?.focus();
}

/** Languages of the skipped blocks, first-seen order, no repeats. */
function skippedLanguages(s: LivePopupState): string[] {
	return [...new Set(skippedLiveBlocks(s).flatMap((b) => (b.lang ? [b.lang] : [])))];
}
