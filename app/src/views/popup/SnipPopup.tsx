// The Snip popup view (GLIM-65; snip-popup.md §2, §4, §7, §10, §11). Renders the state
// main pushes (`SnipStateMessage`) and sends intents back. No state of its own beyond
// what the DOM needs (focus, measuring).
import {
	egressCopy,
	type FooterLayout,
	facingEdge,
	footerLayout,
	listedBlocks,
	type SnipBlock,
	type SnipPopupState,
	showLanguageTags,
	skippedBlocks,
	skippedLanguages,
	snipStatus,
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
	ProgressBar,
	SkippedLine,
	StateMessage,
	TextBlock,
	TextButton,
	Toolbar,
	Tooltip,
} from "@glimpse/ui";
import { createEffect, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import type { SnipAction, SnipStateMessage, SnipViewInit } from "../../shared/popup-rpc.ts";
import {
	alreadyIn,
	announcement,
	COPY,
	type ErrorBody,
	errorBody,
	packDownloadText,
	packFailedText,
	packOfflineText,
	packProgressLabel,
	packProgressText,
	packRowText,
	statusText,
} from "./copy.ts";

export interface SnipPopupIntents {
	painted(requestId: string): void;
	resized(requestId: string, contentHeight: number): void;
	dismiss(requestId: string, reason: "esc" | "close"): void;
	skipped(requestId: string, expanded: boolean): void;
	action(requestId: string, action: SnipAction, lang?: string): void;
	retryBlock(requestId: string, blockId: string): void;
	original(requestId: string, on: boolean): void;
	copy(requestId: string, what: "translation" | "original"): void;
	/** Hover or focus on a block (null: left it): main lights its box on screen (GLIM-115). */
	hoverBlock?(requestId: string, blockId: string | null): void;
}

export interface SnipPopupProps {
	init: SnipViewInit;
	message: SnipStateMessage;
	intents: SnipPopupIntents;
	/** Frame scheduler (tests and screenshots can pass a synchronous one). */
	raf?: (cb: () => void) => void;
}

const isSkeleton = (s: SnipPopupState) => s.blocks.length === 0 && s.skeletons.length > 0;

export function SnipPopup(props: SnipPopupProps): JSX.Element {
	const raf = (cb: () => void) => (props.raf ?? ((f) => requestAnimationFrame(() => f())))(cb);
	const state = () => props.message.state;
	const id = () => props.message.requestId;
	const uiLang = () => props.init.uiLang;
	let shell: HTMLDivElement | undefined;
	let list: HTMLUListElement | undefined;
	const [entering, setEntering] = createSignal(false);
	const [overflowing, setOverflowing] = createSignal(false);
	// Cloud pill (GLIM-80, §2.4 "Cloud footer wrap"): measured, never truncated.
	let footer: HTMLDivElement | undefined;
	let pillFull: HTMLSpanElement | undefined;
	let pillShort: HTMLSpanElement | undefined;
	const [pillLayout, setPillLayout] = createSignal<FooterLayout>({ ownRow: false, short: false });
	const cloud = () => {
		const p = state().provider;
		return p.kind === "cloud" ? p : null;
	};
	const egress = () => {
		const c = cloud();
		return c ? egressCopy(c, props.message.providerShortName) : null;
	};
	const measureFooter = () => {
		if (!footer || !pillFull || !pillShort || !cloud()) return;
		const cs = getComputedStyle(footer);
		const inner =
			footer.clientWidth -
			(Number.parseFloat(cs.paddingInlineStart) || 0) -
			(Number.parseFloat(cs.paddingInlineEnd) || 0);
		const gap = Number.parseFloat(cs.columnGap) || 8;
		let rest = 0;
		for (const el of footer.querySelectorAll<HTMLElement>("[data-footer-rest], .snip-status, .snip-actions"))
			rest += el.offsetWidth + gap;
		const next = footerLayout({ footer: inner, pill: pillFull.offsetWidth, shortPill: pillShort.offsetWidth, rest });
		const cur = pillLayout();
		if (next.ownRow !== cur.ownRow || next.short !== cur.short) setPillLayout(next);
	};

	// A new request: reset scroll and focus, play the enter animation, report `painted`
	// after two frames so main shows the window on a fresh frame (§8).
	createEffect(
		on(id, (requestId) => {
			if (list) list.scrollTop = 0;
			setEntering(false);
			raf(() => {
				setEntering(true);
				list?.focus({ preventScroll: true });
				raf(() => props.intents.painted(requestId));
			});
		}),
	);

	// Natural content height (the list unscrolled + everything around it), once per frame.
	let measureQueued = false;
	const measure = () => {
		if (measureQueued) return;
		measureQueued = true;
		raf(() => {
			measureQueued = false;
			measureFooter();
			if (!shell || !list) return;
			const chrome = shell.offsetHeight - list.clientHeight;
			const natural = Math.ceil(list.scrollHeight + chrome);
			setOverflowing(list.scrollHeight > list.clientHeight + 1);
			props.intents.resized(id(), natural);
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

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			props.intents.dismiss(id(), "esc");
			return;
		}
		// Ctrl+Shift+O / ⌘⇧O: original view (§11). Popup-local, never global.
		const mod = props.init.os === "macos" ? e.metaKey : e.ctrlKey;
		if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") {
			e.preventDefault();
			toggleOriginal();
			return;
		}
		// Ctrl/⌘C copies the translation again unless text is selected (then the selection
		// is copied the normal way); Ctrl/⌘⇧C copies the original (§6, §11).
		if (mod && !e.altKey && e.key.toLowerCase() === "c") {
			if (e.shiftKey) {
				e.preventDefault();
				props.intents.copy(id(), "original");
			} else if (!hasSelection(shell)) {
				e.preventDefault();
				props.intents.copy(id(), "translation");
			}
			return;
		}
		if (e.key === "Tab" && shell) trapTab(shell, list, e);
	};
	const original = () => state().view === "original";
	const canCopy = () =>
		state().blocks.some((b) => b.cls !== "skip") && (!state().error || state().error === "packMissing");
	const toggleOriginal = () => {
		if (state().blocks.length > 0) props.intents.original(id(), !original());
	};

	const status = () => snipStatus(state());
	const error = (): ErrorBody | null => {
		const kind = state().error;
		return kind ? errorBody(kind, state(), props.init.os, uiLang(), props.message.localAvailable) : null;
	};
	let errorEl: HTMLDivElement | undefined;
	// Error states: keyboard focus moves to the first action (§4.1, §7.3).
	createEffect(
		on(
			() => state().error,
			(kind) => {
				if (!kind) return;
				raf(() => (errorEl?.querySelector("button") ?? list)?.focus({ preventScroll: true }));
			},
		),
	);
	const act = (action: SnipAction, lang?: string) => props.intents.action(id(), action, lang);
	const translatedCount = () => state().blocks.filter((b) => b.cls === "translate" && b.state === "done").length;
	const tags = () => showLanguageTags(state());

	return (
		<PopupShell
			kind="snip"
			ref={shell}
			dir={props.init.uiDir}
			lang={uiLang()}
			facing={facingEdge(props.message.layout.side)}
			entering={entering() && !props.message.reducedMotion}
			aria-label={COPY.dialog}
			class="snip-popup"
			data-reduced-motion={props.message.reducedMotion ? "" : undefined}
			onKeyDown={onKeyDown}
		>
			<Show when={error()}>
				{(e) => (
					<div class="snip-error" ref={errorEl} id={`snip-error-${id()}`}>
						<StateMessage title={e().title} tone={e().tone}>
							{e().body}
						</StateMessage>
						<Show when={state().error === "packMissing" && downloading(state())}>
							<PackProgress state={state()} uiLang={uiLang()} />
						</Show>
						<Show when={e().buttons.length > 0 && !(state().error === "packMissing" && downloading(state()))}>
							<div class="snip-error-actions">
								<For each={e().buttons}>
									{(b) => (
										<Button variant={b.primary ? "primary" : "secondary"} onClick={() => act(b.action, b.lang)}>
											{b.label}
										</Button>
									)}
								</For>
							</div>
						</Show>
					</div>
				)}
			</Show>
			<Show when={!state().error && state().packs.length > 0}>
				<PackRows
					rows={state().packs}
					text={(row) => packRowText(row.lang, uiLang())}
					downloadLabel={(row) => packDownloadText(row.bytes)}
					offlineText={packOfflineText}
					failedText={packFailedText}
					progressLabel={(row) => packProgressLabel(row.lang, uiLang())}
					progressText={packProgressText}
					onDownload={(row) => act("download", row.lang)}
				/>
			</Show>
			<BlockList
				ref={(el) => (list = el)}
				aria-label={COPY.list}
				aria-describedby={error() ? `snip-error-${id()}` : undefined}
				class="snip-list"
			>
				<Show when={isSkeleton(state())}>
					<For each={state().skeletons}>{(w) => <TextBlock state="skeleton" skeletonWidth={w} />}</For>
				</Show>
				<Show when={!error() || error()?.showOriginal}>
					<For each={listedBlocks(state())}>
						{(b) => (
							<Block
								block={b}
								state={state()}
								tags={tags()}
								uiLang={uiLang()}
								plain={!!error()}
								view={state().view}
								showSource={state().showOriginalUnder}
								onRetry={() => props.intents.retryBlock(id(), b.id)}
								onLink={(on) => props.intents.hoverBlock?.(id(), on ? b.id : null)}
							/>
						)}
					</For>
				</Show>
				<Show when={skippedBlocks(state()).length > 0}>
					<SkippedLine
						count={skippedBlocks(state()).length}
						languages={skippedLanguages(state()).map((l) => languageName(l, uiLang()))}
						uiLocale={uiLang()}
						expanded={state().skippedExpanded}
						onExpandedChange={(x) => props.intents.skipped(id(), x)}
					>
						<For each={skippedBlocks(state())}>
							{(b) => (
								<TextBlock
									state="done"
									kind="neutral"
									source={b.source}
									sourceLang={b.lang ?? undefined}
									tag={b.lang ? languageName(b.lang, uiLang()) : undefined}
									tagLang={uiLang()}
								/>
							)}
						</For>
						<li class="snip-skipped-actions">
							<TextButton onClick={() => act("translateSkipped")}>{COPY.translateThese}</TextButton>
							<TextButton onClick={() => act("editSources")}>{COPY.editSources}</TextButton>
						</li>
					</SkippedLine>
				</Show>
			</BlockList>
			<div
				ref={footer}
				class="snip-footer electrobun-webkit-app-region-drag"
				data-divider={overflowing() ? "" : undefined}
			>
				<Show when={cloud()} fallback={<LocalIndicator label={COPY.local} tooltip={COPY.localTooltip} />}>
					{(c) => (
						<>
							{/* Off-screen copies at full and short length, so the footer knows what fits. */}
							<span class="snip-egress-measure" aria-hidden="true">
								<span ref={pillFull}>
									<EgressBadge provider={c().name} label={egress()?.label} />
								</span>
								<span ref={pillShort}>
									<EgressBadge provider={c().name} label={egress()?.shortLabel} />
								</span>
							</span>
							<span class="snip-egress" data-own-row={pillLayout().ownRow ? "" : undefined}>
								<EgressBadge
									provider={c().name}
									remembered={c().remembered}
									label={pillLayout().short ? egress()?.shortLabel : egress()?.label}
									short={pillLayout().short}
									shortName={props.message.providerShortName ?? undefined}
									tooltip={egress()?.tooltip}
								/>
							</span>
						</>
					)}
				</Show>
				<Show when={state().private}>
					<Tooltip content={COPY.privateTooltip}>
						<span class="snip-private" data-footer-rest>
							<Icon name="eye-off" />
							{COPY.private}
						</span>
					</Tooltip>
				</Show>
				<span class="snip-spacer" />
				<span class="snip-status" aria-hidden="true">
					<Show when={status().kind === "copied"}>
						<Icon name="check" />
					</Show>
					{statusText(status())}
				</span>
				<span class="sr-only" role="status">
					{error()?.title ?? announcement(status(), translatedCount(), state().phase === "done", state().autoCopied)}
				</span>
				<Toolbar label={COPY.actions} class="snip-actions electrobun-webkit-app-region-no-drag">
					<IconButton
						icon="original"
						label={original() ? COPY.showTranslation : COPY.showOriginal}
						shortcut={props.init.keys.original}
						pressed={original()}
						disabled={state().blocks.length === 0}
						onClick={toggleOriginal}
					/>
					<IconButton
						icon="copy"
						label={COPY.copyTranslation}
						shortcut={props.init.keys.copy}
						disabled={!canCopy()}
						onClick={() => props.intents.copy(id(), "translation")}
					/>
					<IconButton
						icon="close"
						label={COPY.close}
						shortcut={props.init.keys.close}
						onClick={() => props.intents.dismiss(id(), "close")}
					/>
				</Toolbar>
			</div>
		</PopupShell>
	);
}

const downloading = (s: SnipPopupState) => s.packs.some((p) => p.state === "downloading");

function PackProgress(props: { state: SnipPopupState; uiLang: string }): JSX.Element {
	const rows = () => props.state.packs.filter((p) => p.state === "downloading");
	const done = () => rows().reduce((n, r) => n + (r.received ?? 0), 0);
	const total = () => rows().reduce((n, r) => n + (r.total ?? 0), 0);
	return (
		<div class="snip-error-actions">
			<ProgressBar
				label={`Downloading ${rows()
					.map((r) => languageName(r.lang, props.uiLang))
					.join(", ")}`}
				done={done()}
				total={total()}
				line={packProgressText(done(), total())}
			/>
		</div>
	);
}

function Block(props: {
	block: SnipBlock;
	state: SnipPopupState;
	tags: boolean;
	uiLang: string;
	/** Error states list the original text plainly (E2, E3). */
	plain: boolean;
	view: "translation" | "original";
	showSource: boolean;
	onRetry: () => void;
	onLink?: (linked: boolean) => void;
}): JSX.Element {
	const b = () => props.block;
	const target = () => props.state.target ?? undefined;
	const lang = () => b().lang ?? undefined;
	const kind = () => (props.plain || b().cls === "neutral" ? "neutral" : b().cls === "target" ? "target" : "translate");
	const view = () => {
		if (props.plain) return "done";
		const s = b().state;
		return s === "waiting" ? "pending" : s;
	};
	const tag = () => {
		if (b().cls === "target") return target() ? alreadyIn(target() as string, props.uiLang) : undefined;
		if (b().cls === "translate" && props.tags && b().lang) return languageName(b().lang as string, props.uiLang);
		return undefined;
	};
	return (
		<TextBlock
			state={view()}
			kind={kind()}
			translation={b().state === "done" ? (b().translation ?? undefined) : undefined}
			// A pending block shows its streamed text (translated sentences + remaining source).
			source={b().state === "pending" && b().translation ? (b().translation ?? b().source) : b().source}
			sourceLang={lang()}
			targetLang={target()}
			tag={tag()}
			tagLang={props.uiLang}
			view={props.view}
			showSource={props.showSource}
			failedLabel={COPY.failed}
			retryLabel={COPY.retry}
			onRetry={props.onRetry}
			onLinkChange={props.onLink}
		/>
	);
}

/** Text selected inside the popup (Ctrl/⌘C then copies the selection, not the translation). */
function hasSelection(root: HTMLElement | undefined): boolean {
	const sel = typeof window !== "undefined" ? window.getSelection() : null;
	if (!sel || sel.isCollapsed || sel.toString().length === 0) return false;
	return !root || (sel.anchorNode !== null && root.contains(sel.anchorNode));
}

/** Focus stays inside the popup: Tab wraps from the last control to the first block (§7.6). */
function trapTab(shell: HTMLElement, list: HTMLElement | undefined, e: KeyboardEvent): void {
	// Every Tab stop in DOM order: buttons, the block list's active item, links. Hidden ones
	// (display: none) can't take focus, so they don't count (GLIM-83: with no blocks the old
	// wrap target was the hidden list and focus stuck on the last button).
	const stops = [...shell.querySelectorAll<HTMLElement>("button, [tabindex='0'], a[href]")].filter(
		(el) => !el.hasAttribute("disabled") && el.getAttribute("tabindex") !== "-1" && el.getClientRects().length > 0,
	);
	const first = stops[0];
	const last = stops.at(-1);
	if (!first || !last) return;
	const active = document.activeElement;
	// The list itself takes focus when the popup opens (tabindex -1); when it comes before
	// every stop, Shift+Tab from it wraps too.
	const listFirst =
		!!list && active === list && !!(list.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING);
	if (!e.shiftKey && active === last) {
		e.preventDefault();
		first.focus();
	} else if (e.shiftKey && (active === first || listFirst)) {
		e.preventDefault();
		last.focus();
	}
}
