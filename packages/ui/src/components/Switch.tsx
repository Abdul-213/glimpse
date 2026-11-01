import { Switch as KSwitch } from "@kobalte/core/switch";
import { type JSX, Show } from "solid-js";

export interface SwitchProps {
	label: JSX.Element;
	description?: JSX.Element;
	checked?: boolean;
	defaultChecked?: boolean;
	onChange?: (checked: boolean) => void;
	disabled?: boolean;
	/**
	 * `row`: label and description at inline-start, switch at inline-end (a settings row).
	 * `inline`: switch then label. `hidden-label`: switch only, label for screen readers.
	 */
	layout?: "row" | "inline" | "hidden-label";
	name?: string;
}

/**
 * macOS small switch / Windows toggle switch (DESIGN.md Settings and onboarding controls),
 * on Kobalte's Switch (role="switch", label and description wiring, keyboard).
 */
export function Switch(props: SwitchProps): JSX.Element {
	const layout = () => props.layout ?? "row";
	const control = () => (
		<>
			<KSwitch.Input />
			<KSwitch.Control class="glim-switch-control">
				<KSwitch.Thumb class="glim-switch-thumb" />
			</KSwitch.Control>
		</>
	);
	return (
		<KSwitch
			class="glim-switch"
			classList={{ "w-full": layout() === "row" }}
			checked={props.checked}
			defaultChecked={props.defaultChecked}
			onChange={(v: boolean) => props.onChange?.(v)}
			disabled={props.disabled}
			name={props.name}
		>
			<Show
				when={layout() === "row"}
				fallback={
					<>
						{control()}
						<KSwitch.Label class="glim-label" classList={{ "sr-only": layout() === "hidden-label" }}>
							{props.label}
						</KSwitch.Label>
					</>
				}
			>
				<span class="flex min-w-0 flex-1 flex-col gap-0.5">
					<KSwitch.Label class="glim-label">{props.label}</KSwitch.Label>
					<Show when={props.description}>
						<KSwitch.Description class="glim-description">{props.description}</KSwitch.Description>
					</Show>
				</span>
				{control()}
			</Show>
		</KSwitch>
	);
}
