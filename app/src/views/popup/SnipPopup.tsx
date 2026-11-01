// The Snip popup view (GLIM-65; snip-popup.md §2, §4, §7, §10, §11). Renders the state
// main pushes (`SnipStateMessage`) and sends intents back. No state of its own beyond
// what the DOM needs (focus, measuring).
import {
	facingEdge,
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
	EgressBadge,
	Icon,
	IconButton,
	LocalIndicator,
	languageName,
	PopupShell,
	SkippedLine,
	TextBlock,
	Toolbar,
	Tooltip,
} from "@glimpse/ui";
import { createEffect, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import type { SnipStateMessage, SnipViewInit } from "../../shared/popup-rpc.ts";
import { alreadyIn, announcement, COPY, statusText } from "./copy.ts";

export interface SnipPopupIntents {
	painted(requestId: string): void;
	resized(requestId: string, contentHeight: number): void;
	dismiss(requestId: string, reason: "esc" | "close"): void;
	skipped(requestId: string, expanded: boolean): void;
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
		if (e.key === "Tab" && shell) trapTab(shell, list, e);
	};

	const status = () => snipStatus(state());
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
			<BlockList ref={(el) => (list = el)} aria-label={COPY.list} class="snip-list">
				<Show when={isSkeleton(state())}>
					<For each={state().skeletons}>{(w) => <TextBlock state="skeleton" skeletonWidth={w} />}</For>
				</Show>
				<For each={listedBlocks(state())}>
					{(b) => <Block block={b} state={state()} tags={tags()} uiLang={uiLang()} />}
				</For>
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
					</SkippedLine>
				</Show>
			</BlockList>
			<div class="snip-footer" data-divider={overflowing() ? "" : undefined}>
				<Show
					when={state().provider.kind === "cloud" ? state().provider : null}
					fallback={<LocalIndicator label={COPY.local} tooltip={COPY.localTooltip} />}
				>
					{(p) => {
						const c = p() as Extract<SnipPopupState["provider"], { kind: "cloud" }>;
						return <EgressBadge provider={c.name} remembered={c.remembered} />;
					}}
				</Show>
				<Show when={state().private}>
					<Tooltip content={COPY.privateTooltip}>
						<span class="snip-private">
							<Icon name="eye-off" />
							{COPY.private}
						</span>
					</Tooltip>
				</Show>
				<span class="snip-spacer" />
				<span class="snip-status" aria-hidden="true">
					{statusText(status())}
				</span>
				<span class="sr-only" role="status">
					{announcement(status(), translatedCount(), state().phase === "done")}
				</span>
				<Toolbar label={COPY.actions} class="snip-actions">
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

function Block(props: { block: SnipBlock; state: SnipPopupState; tags: boolean; uiLang: string }): JSX.Element {
	const b = () => props.block;
	const target = () => props.state.target ?? undefined;
	const lang = () => b().lang ?? undefined;
	const kind = () => (b().cls === "neutral" ? "neutral" : b().cls === "target" ? "target" : "translate");
	const view = () => {
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
			failedLabel={COPY.failed}
		/>
	);
}

/** Focus stays inside the popup: Tab wraps from the last control to the first block (§7.6). */
function trapTab(shell: HTMLElement, list: HTMLElement | undefined, e: KeyboardEvent): void {
	const stops = [...shell.querySelectorAll<HTMLElement>("button, [tabindex='0'], a[href]")].filter(
		(el) => !el.hasAttribute("disabled") && el.getAttribute("tabindex") !== "-1",
	);
	const firstBlock = list?.querySelector<HTMLElement>("[data-block], [data-roving]") ?? list;
	const first = firstBlock ?? stops[0];
	const last = stops.at(-1);
	if (!first || !last) return;
	const active = document.activeElement;
	if (!e.shiftKey && active === last) {
		e.preventDefault();
		first.focus();
	} else if (e.shiftKey && (active === first || active === list || list?.contains(active))) {
		e.preventDefault();
		last.focus();
	}
}
