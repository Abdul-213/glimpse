// The docked Live popup view (GLIM-79; live-popup.md §2, §4, §7, §9, §10). Renders the state
// main pushes (`LiveStateMessage`) and sends intents back.
//
// In-place updates: the state is reconciled into a store keyed by block id, so a frame that
// changes one block re-renders that block only; the others keep their DOM nodes (and their
// running flash animations). A block's `changeId` restarts its flash → rest tint and moves the
// mark (TextBlock); reduced motion shows the resting tint and the mark at once (CSS).
import {
	facingEdge,
	type LivePopupBlock,
	type LivePopupState,
	listedLiveBlocks,
	liveShowsEmpty,
	liveStrip,
	stripLayout,
} from "@glimpse/core";
import {
	BlockList,
	Button,
	EgressBadge,
	IconButton,
	LocalIndicator,
	PopupShell,
	StateMessage,
	StatusIndicator,
	TextBlock,
	Toolbar,
} from "@glimpse/ui";
import { createEffect, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { LiveConsentAnswer, LiveStateMessage, LiveViewInit } from "../../shared/live-rpc.ts";
import {
	COPY,
	company,
	consentCopy,
	egressTooltip,
	errorCopy,
	type LiveErrorAction,
	pauseLabel,
	staleText,
	statusLabel,
} from "./copy.ts";
import { liveKey } from "./keys.ts";

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
}

export interface LivePopupProps {
	init: LiveViewInit;
	message: LiveStateMessage;
	intents: LivePopupIntents;
	/** Frame scheduler (screenshots can pass a synchronous one). */
	raf?: (cb: () => void) => void;
	/** Delay before reporting a smaller height, so removed blocks animate first (§9). */
	shrinkDelayMs?: number;
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
		}
	};

	return (
		<PopupShell
			kind="live"
			ref={shell}
			dir={props.init.uiDir}
			lang={uiLang()}
			facing={facingEdge(props.message.layout.side)}
			entering={entering() && !props.message.reducedMotion}
			aria-label={COPY.region}
			class="live-popup"
			data-layout={layout()}
			data-stale={state().stale ? "" : undefined}
			onKeyDown={onKeyDown}
			onPointerEnter={() => {
				setPointerInside(true);
				props.intents.pointerEntered(id());
			}}
			onPointerLeave={() => setPointerInside(false)}
		>
			<div class="live-strip">
				<StatusIndicator
					status={strip().dot}
					label={statusLabel(strip().label, state().private, layout() === "compact")}
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
									<Show when={state().consent?.reason !== "cloud-ocr"}>
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
			<BlockList ref={(el) => (list = el)} aria-label={COPY.list} class="live-list">
				<Show when={state().status !== "consent"}>
					<For each={listedLiveBlocks(state())}>
						{(b) => (
							<LiveTextBlock
								block={b}
								stale={state().stale}
								original={original()}
								marked={b.changeId !== null && b.changeId === state().changeSeq}
								linked={hovered() === b.id}
								onLink={(on) => hover(b.id, on)}
							/>
						)}
					</For>
				</Show>
			</BlockList>
			<span class="sr-only" role="status">
				{state().status === "paused" || state().status === "error" ? COPY.a11yPaused : ""}
			</span>
		</PopupShell>
	);
}

function LiveTextBlock(props: {
	block: LivePopupBlock;
	stale: boolean;
	marked: boolean;
	linked: boolean;
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
