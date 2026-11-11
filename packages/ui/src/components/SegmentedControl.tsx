import { SegmentedControl as KSegmented } from "@kobalte/core/segmented-control";
import { For, type JSX } from "solid-js";

export interface SegmentOption {
	value: string;
	label: string;
	disabled?: boolean;
}

export interface SegmentedControlProps {
	/** Accessible name of the group ("Motion"). */
	label: string;
	options: readonly SegmentOption[];
	value?: string;
	defaultValue?: string;
	onChange?: (value: string) => void;
	disabled?: boolean;
}

/** Two to four short, mutually exclusive options (DESIGN.md `segmented`). A radio group underneath. */
export function SegmentedControl(props: SegmentedControlProps): JSX.Element {
	return (
		<KSegmented
			class="glim-segmented"
			aria-label={props.label}
			value={props.value}
			defaultValue={props.defaultValue}
			onChange={(v: string) => props.onChange?.(v)}
			disabled={props.disabled}
		>
			<For each={props.options}>
				{(o) => (
					<KSegmented.Item value={o.value} disabled={o.disabled} class="glim-segment">
						<KSegmented.ItemInput />
						<KSegmented.ItemLabel>{o.label}</KSegmented.ItemLabel>
					</KSegmented.Item>
				)}
			</For>
		</KSegmented>
	);
}
