import { createSignal, createUniqueId, type JSX, Show } from "solid-js";
import { skippedLabel } from "../format.ts";
import { Icon } from "./Icon.tsx";

export interface SkippedLineProps {
	count: number;
	/** Detected language names, in the UI language ("Japanese", "Korean"). */
	languages: readonly string[];
	uiLocale?: string;
	/** Overrides the default "{n} blocks skipped · {languages}". */
	label?: string;
	/** Controlled expansion (Live keeps it for the session). Omit for uncontrolled. */
	expanded?: boolean;
	defaultExpanded?: boolean;
	onExpandedChange?: (expanded: boolean) => void;
	/** The skipped blocks (TextBlocks with tags) and the two text-button actions. */
	children?: JSX.Element;
}

/**
 * "N blocks skipped" (DESIGN.md Components): the last row of the block list, a quiet
 * button that expands the skipped blocks inline. Never a warning colour: skipping is the
 * user's filter working.
 */
export function SkippedLine(props: SkippedLineProps): JSX.Element {
	const id = createUniqueId();
	const [own, setOwn] = createSignal(props.defaultExpanded ?? false);
	const expanded = () => props.expanded ?? own();
	const toggle = () => {
		const next = !expanded();
		setOwn(next);
		props.onExpandedChange?.(next);
	};
	return (
		<li>
			<button
				type="button"
				class="glim-skipped"
				data-roving=""
				tabindex={-1}
				aria-expanded={expanded() ? "true" : "false"}
				aria-controls={expanded() ? `skipped-${id}` : undefined}
				onClick={toggle}
			>
				<Icon name="chevron-end" size={12} />
				<span class="min-w-0">{props.label ?? skippedLabel(props.count, props.languages, props.uiLocale)}</span>
			</button>
			<Show when={expanded()}>
				<ul id={`skipped-${id}`} class="m-0 mt-2 flex list-none flex-col gap-2 p-0">
					{props.children}
				</ul>
			</Show>
		</li>
	);
}
