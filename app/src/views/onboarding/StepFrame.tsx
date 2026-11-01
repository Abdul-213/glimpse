import { type JSX, Show } from "solid-js";

export interface StepFrameProps {
	title: string;
	/** One paragraph of body copy (DESIGN.md Layout > Onboarding). */
	lead?: JSX.Element;
	/** Above the title: the step strip, when the window walks through several steps. */
	header?: JSX.Element;
	/** Footer, inline-start: Back / Skip. */
	start?: JSX.Element;
	/** Footer, inline-end: the primary action (one per view) and anything beside it. */
	end?: JSX.Element;
	/** Footer, between start and end: download progress that stays visible across steps. */
	middle?: JSX.Element;
	children?: JSX.Element;
}

/**
 * One onboarding step (DESIGN.md Layout > Onboarding, 560 x 480): title, one paragraph, the
 * step's control or status, and the primary action at the block-end, inline-end corner with
 * Back at inline-start. The body scrolls; the footer stays put.
 */
export function StepFrame(props: StepFrameProps): JSX.Element {
	return (
		<div class="onboarding-shell flex h-dvh flex-col text-text-primary">
			<Show when={props.header}>{props.header}</Show>
			<main class="onboarding-body min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-4" aria-labelledby="step-title">
				<h1 id="step-title" class="m-0 text-title" tabindex="-1">
					{props.title}
				</h1>
				<Show when={props.lead}>
					<p class="m-0 mt-2 max-w-[60ch] text-body text-text-secondary">{props.lead}</p>
				</Show>
				<Show when={props.children}>
					<div class="mt-5 flex flex-col gap-4">{props.children}</div>
				</Show>
			</main>
			<footer class="onboarding-footer flex shrink-0 items-center gap-3 px-6 py-4">
				<div class="flex items-center gap-3">{props.start}</div>
				<div class="flex min-w-0 flex-1 items-center justify-end">{props.middle}</div>
				<div class="flex items-center gap-2">{props.end}</div>
			</footer>
		</div>
	);
}
