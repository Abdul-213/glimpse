import { TextField as KTextField } from "@kobalte/core/text-field";
import { createSignal, type JSX, Show } from "solid-js";
import { Icon } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";

export interface InlineMessageProps {
	tone: "danger" | "warning";
	id?: string;
	children: JSX.Element;
}

/** DESIGN.md Inline error: `label` type in `danger` (or `warning`) with an icon, under its field. */
export function InlineMessage(props: InlineMessageProps): JSX.Element {
	return (
		<p id={props.id} class="glim-inline-message" data-tone={props.tone}>
			<Icon name={props.tone === "danger" ? "alert" : "warning"} class="mt-px" />
			<span>{props.children}</span>
		</p>
	);
}

export interface TextFieldProps {
	label: JSX.Element;
	hideLabel?: boolean;
	description?: JSX.Element;
	/** Validation message; marks the field invalid. */
	error?: string;
	value?: string;
	onChange?: (value: string) => void;
	placeholder?: string;
	type?: "text" | "password" | "url" | "search";
	disabled?: boolean;
	/** `ui-monospace`, for literal data such as API keys. */
	mono?: boolean;
	/** Extra control inside the field at its inline-end edge. */
	end?: JSX.Element;
	autocomplete?: string;
	name?: string;
}

/** DESIGN.md `field` with label, description and inline error, on Kobalte TextField. */
export function TextField(props: TextFieldProps): JSX.Element {
	return (
		<KTextField
			class="flex flex-col gap-1"
			value={props.value}
			onChange={(v: string) => props.onChange?.(v)}
			validationState={props.error ? "invalid" : "valid"}
			disabled={props.disabled}
			name={props.name}
		>
			<KTextField.Label class="glim-label" classList={{ "sr-only": props.hideLabel }}>
				{props.label}
			</KTextField.Label>
			<div
				class="glim-field"
				data-invalid={props.error ? "" : undefined}
				data-disabled={props.disabled ? "" : undefined}
				data-mono={props.mono ? "" : undefined}
			>
				<KTextField.Input
					type={props.type ?? "text"}
					placeholder={props.placeholder}
					autocomplete={props.autocomplete ?? "off"}
					spellcheck={false}
				/>
				{props.end}
			</div>
			<Show when={props.description}>
				<KTextField.Description class="glim-description">{props.description}</KTextField.Description>
			</Show>
			<KTextField.ErrorMessage class="glim-inline-message" data-tone="danger">
				<Icon name="alert" class="mt-px" />
				<span>{props.error}</span>
			</KTextField.ErrorMessage>
		</KTextField>
	);
}

export interface SecretFieldProps extends Omit<TextFieldProps, "type" | "mono" | "end"> {
	/** A key is already stored in the OS keychain. It is never shown back. */
	stored?: boolean;
	/** "Saved in Keychain" / "Saved in Credential Manager". */
	storedLabel?: string;
	revealLabel?: string;
	concealLabel?: string;
}

/**
 * API key field (DESIGN.md Secret field): monospace, hidden by default with a show/hide
 * button. A stored key is never read back into the webview; the placeholder says it is
 * saved, and typing a new key replaces it.
 */
export function SecretField(props: SecretFieldProps): JSX.Element {
	const [revealed, setRevealed] = createSignal(false);
	return (
		<TextField
			{...props}
			mono
			type={revealed() ? "text" : "password"}
			placeholder={props.stored ? (props.storedLabel ?? "Saved in Keychain") : props.placeholder}
			end={
				<IconButton
					icon={revealed() ? "eye-off" : "eye"}
					label={revealed() ? (props.concealLabel ?? "Hide key") : (props.revealLabel ?? "Show key")}
					pressed={revealed()}
					class="-me-1"
					onClick={() => setRevealed(!revealed())}
				/>
			}
		/>
	);
}
