import { createUniqueId, type JSX, Show } from "solid-js";

export interface SettingsGroupProps {
	title?: JSX.Element;
	/** A sentence under the group ("Glimpse uses these when nothing else is set."). */
	footer?: JSX.Element;
	children: JSX.Element;
}

/**
 * A settings group (DESIGN.md Settings groups and rows): heading 20px above / 8px below,
 * then one hairline container with dividers on macOS, or stacked cards on Windows.
 */
export function SettingsGroup(props: SettingsGroupProps): JSX.Element {
	const id = createUniqueId();
	return (
		<section aria-labelledby={props.title ? `grp-${id}` : undefined} class="mt-5 flex flex-col first:mt-0">
			<Show when={props.title}>
				<h2 id={`grp-${id}`} class="m-0 mb-2 text-heading">
					{props.title}
				</h2>
			</Show>
			<div class="glim-group">{props.children}</div>
			<Show when={props.footer}>
				<p class="glim-description mt-2 px-3">{props.footer}</p>
			</Show>
		</section>
	);
}

export interface SettingsRowIds {
	labelId: string;
	descriptionId: string;
}

export interface SettingsRowProps {
	label: JSX.Element;
	description?: JSX.Element;
	/** The control, or a function that receives the ids to wire aria-labelledby/-describedby. */
	children?: JSX.Element | ((ids: SettingsRowIds) => JSX.Element);
}

/** A settings row: label and description at inline-start, its control at inline-end. */
export function SettingsRow(props: SettingsRowProps): JSX.Element {
	const id = createUniqueId();
	const ids: SettingsRowIds = { labelId: `row-${id}`, descriptionId: `row-${id}-d` };
	const control = () => {
		const c = props.children;
		return typeof c === "function" ? c(ids) : c;
	};
	return (
		<div class="glim-row">
			<div class="flex min-w-0 flex-1 flex-col gap-0.5">
				<span id={ids.labelId} class="glim-label">
					{props.label}
				</span>
				<Show when={props.description}>
					<p id={ids.descriptionId} class="glim-description">
						{props.description}
					</p>
				</Show>
			</div>
			<Show when={props.children}>
				<div class="flex shrink-0 items-center">{control()}</div>
			</Show>
		</div>
	);
}

/** A row whose whole content is one control that brings its own label (Switch with layout="row"). */
export function SettingsControlRow(props: { children: JSX.Element }): JSX.Element {
	return <div class="glim-row">{props.children}</div>;
}
