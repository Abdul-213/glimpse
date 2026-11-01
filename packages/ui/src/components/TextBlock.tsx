import { createMemo, type JSX, Match, Show, Switch } from "solid-js";
import { Icon } from "./Icon.tsx";
import { TextButton } from "./TextButton.tsx";

/**
 * - `skeleton`: OCR detection returned a box but no text yet (static bar, no shimmer).
 * - `pending`:  OCR text is known; its translation isn't (source text in source style).
 * - `done`:     translated (or shown as-is for neutral / already-in-target blocks).
 * - `failed`:   translation failed for this block; its source stays visible.
 */
export type BlockState = "skeleton" | "pending" | "done" | "failed";

/** GLIM-21 classes as the popup renders them. Skipped blocks are TextBlocks inside SkippedLine. */
export type BlockKind = "translate" | "neutral" | "target";

export interface TextBlockProps {
	state: BlockState;
	kind?: BlockKind;
	/** Translated text; for `target` blocks, the text itself. */
	translation?: string;
	/** BCP-47 tag of the translation (the target language). Picks its script stack. */
	targetLang?: string;
	/** OCR text. */
	source?: string;
	/** Detected source language tag. */
	sourceLang?: string;
	/** "Show original under translation" (Settings). */
	showSource?: boolean;
	/** Original view (Ctrl/⌘⇧O): the OCR text becomes the content, in translation type. */
	view?: "translation" | "original";
	/** Per-block language tag ("Japanese", "Already in English"), in the UI language. */
	tag?: string;
	tagLang?: string;
	/** Skeleton bar width in % (see `skeletonWidth`). */
	skeletonWidth?: number;
	variant?: "snip" | "live";
	/**
	 * Live only: identity of the change set that last changed this block. A new value
	 * restarts the flash → rest tint and moves the mark here; null/undefined clears both.
	 */
	changeId?: string | number | null;
	/** Live paused or in error: text drops to secondary. */
	stale?: boolean;
	/** This block's detected box is lit on screen (hover/focus from either side). */
	linked?: boolean;
	onLinkChange?: (linked: boolean) => void;
	failedLabel?: string;
	retryLabel?: string;
	onRetry?: () => void;
	/** Spoken with a changed Live block so the mark isn't the only signal. */
	changedLabel?: string;
}

/**
 * One OCR block in a Snip or Live popup (DESIGN.md Translation block, Live changed block).
 * Every text node carries its `lang` and `dir="auto"`; `:lang()` rules in tokens.css choose
 * the script's font stack, size step and leading per block.
 */
export function TextBlock(props: TextBlockProps): JSX.Element {
	const kind = () => props.kind ?? "translate";
	// Fade the translation in only when it replaces pending source, not on a cache hit.
	const replacedPending = createMemo<boolean>(
		(prev) => prev || props.state === "pending" || props.state === "skeleton",
		false,
	);
	const busy = () => props.state === "pending" || props.state === "skeleton";
	const link = (on: boolean) => props.onLinkChange?.(on);

	const sourceLine = (cls: string) => (
		<p class={`glim-text ${cls}`} dir="auto" lang={props.sourceLang}>
			{props.source}
		</p>
	);

	return (
		<li
			class="glim-block"
			data-block=""
			data-variant={props.variant ?? "snip"}
			data-stale={props.stale ? "" : undefined}
			data-linked={props.linked ? "" : undefined}
			tabindex={-1}
			lang={props.targetLang}
			aria-busy={busy() ? "true" : undefined}
			aria-description={props.changeId != null ? (props.changedLabel ?? "Changed") : undefined}
			onPointerEnter={() => link(true)}
			onPointerLeave={() => link(false)}
			onFocus={() => link(true)}
			onBlur={() => link(false)}
		>
			<Show when={props.changeId ?? undefined} keyed>
				{(_id) => (
					<>
						<span class="glim-change-tint" aria-hidden="true" />
						<span class="glim-change-mark" aria-hidden="true" />
					</>
				)}
			</Show>
			<Switch>
				<Match when={props.state === "skeleton"}>
					<span class="glim-skeleton" aria-hidden="true" style={{ width: `${props.skeletonWidth ?? 70}%` }} />
				</Match>
				<Match when={kind() === "neutral"}>
					{/* Skipped blocks (inside SkippedLine) are neutral with a language tag. */}
					<p class="glim-text glim-source" dir="auto" lang={props.sourceLang}>
						{props.source}
						<Show when={props.tag}>
							<span class="glim-tag" lang={props.tagLang} dir="auto">
								{props.tag}
							</span>
						</Show>
					</p>
				</Match>
				<Match when={props.view === "original"}>{sourceLine("glim-translation")}</Match>
				<Match when={props.state === "pending"}>{sourceLine("glim-source")}</Match>
				<Match when={props.state === "failed"}>
					{sourceLine("glim-source")}
					<div class="glim-block-note">
						<span class="inline-flex items-center gap-1 text-danger">
							<Icon name="alert" />
							{props.failedLabel ?? "Not translated"}
						</span>
						<Show when={props.onRetry}>
							<TextButton onClick={() => props.onRetry?.()}>{props.retryLabel ?? "Retry"}</TextButton>
						</Show>
					</div>
				</Match>
				<Match when={props.state === "done"}>
					<p
						class="glim-text glim-translation"
						classList={{ "glim-fade-in": replacedPending() }}
						dir="auto"
						lang={kind() === "target" ? props.sourceLang : props.targetLang}
					>
						{kind() === "target" ? (props.translation ?? props.source) : props.translation}
						<Show when={props.tag}>
							<span class="glim-tag" lang={props.tagLang} dir="auto">
								{props.tag}
							</span>
						</Show>
					</p>
					<Show when={props.showSource && kind() === "translate" && props.source}>{sourceLine("glim-source")}</Show>
				</Match>
			</Switch>
		</li>
	);
}
