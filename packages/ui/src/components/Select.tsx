import { Combobox as KCombobox } from "@kobalte/core/combobox";
import { Select as KSelect } from "@kobalte/core/select";
import { createMemo, createSignal, type JSX, Show } from "solid-js";
import { filterLanguages, type LanguageOption } from "../language-filter.ts";
import { Icon } from "./Icon.tsx";

export interface SelectOption {
	value: string;
	label: string;
	disabled?: boolean;
}

export interface SelectProps {
	options: readonly SelectOption[];
	value?: string;
	onChange?: (value: string) => void;
	/** Accessible name when no visible label is linked ("Target language"). */
	"aria-label"?: string;
	"aria-labelledby"?: string;
	placeholder?: string;
	disabled?: boolean;
}

/** OS chevrons: up-down on macOS (pop-up button), down on Windows (ComboBox). */
function Chevron(): JSX.Element {
	return (
		<span class="ms-auto inline-flex text-text-secondary">
			<Icon name="chevrons-up-down" class="win:hidden" />
			<Icon name="chevron-down" class="hidden win:inline" />
		</span>
	);
}

/** A field-shaped trigger and a `menu` list (DESIGN.md Settings controls), on Kobalte Select. */
export function Select(props: SelectProps): JSX.Element {
	const selected = () => props.options.find((o) => o.value === props.value);
	return (
		<KSelect<SelectOption>
			options={[...props.options]}
			optionValue="value"
			optionTextValue="label"
			optionDisabled="disabled"
			value={selected() ?? null}
			onChange={(o: SelectOption | null) => o && props.onChange?.(o.value)}
			placeholder={props.placeholder}
			disabled={props.disabled}
			gutter={4}
			sameWidth
			itemComponent={(p) => (
				<KSelect.Item item={p.item} class="glim-menu-item">
					<KSelect.ItemLabel>{p.item.rawValue.label}</KSelect.ItemLabel>
					<KSelect.ItemIndicator class="glim-menu-check inline-flex">
						<Icon name="check" />
					</KSelect.ItemIndicator>
				</KSelect.Item>
			)}
		>
			<KSelect.Trigger
				class="glim-field w-full cursor-default"
				aria-label={props["aria-label"]}
				aria-labelledby={props["aria-labelledby"]}
			>
				<KSelect.Value<SelectOption> class="min-w-0 truncate">{(s) => s.selectedOption()?.label}</KSelect.Value>
				<Chevron />
			</KSelect.Trigger>
			<KSelect.Portal>
				<KSelect.Content class="glim-menu">
					<KSelect.Listbox class="outline-none" />
				</KSelect.Content>
			</KSelect.Portal>
		</KSelect>
	);
}

export interface LanguagePickerProps {
	options: readonly LanguageOption[];
	value?: string;
	onChange?: (code: string) => void;
	"aria-label"?: string;
	"aria-labelledby"?: string;
	placeholder?: string;
	emptyLabel?: string;
	disabled?: boolean;
}

/**
 * Language picker with search (Settings › Languages, onboarding). Matches the UI-language
 * name, the language's own name and its code, ignoring accents (`filterLanguages`), and
 * shows the own name after the UI name. Kobalte Combobox underneath.
 */
export function LanguagePicker(props: LanguagePickerProps): JSX.Element {
	const [query, setQuery] = createSignal("");
	const filtered = createMemo(() => filterLanguages(props.options, query()));
	const selected = () => props.options.find((o) => o.code === props.value);
	return (
		<KCombobox<LanguageOption>
			options={filtered()}
			optionValue="code"
			optionTextValue="name"
			optionLabel="name"
			optionDisabled="disabled"
			value={selected() ?? null}
			onChange={(o: LanguageOption | null) => o && props.onChange?.(o.code)}
			onInputChange={setQuery}
			defaultFilter={() => true}
			placeholder={props.placeholder ?? "Search languages"}
			disabled={props.disabled}
			allowsEmptyCollection
			triggerMode="focus"
			gutter={4}
			sameWidth
			itemComponent={(p) => (
				<KCombobox.Item item={p.item} class="glim-menu-item">
					<KCombobox.ItemLabel>{p.item.rawValue.name}</KCombobox.ItemLabel>
					<Show when={p.item.rawValue.nativeName && p.item.rawValue.nativeName !== p.item.rawValue.name}>
						<span class="glim-menu-secondary" lang={p.item.rawValue.code} dir="auto">
							{p.item.rawValue.nativeName}
						</span>
					</Show>
					<KCombobox.ItemIndicator class="glim-menu-check inline-flex">
						<Icon name="check" />
					</KCombobox.ItemIndicator>
				</KCombobox.Item>
			)}
		>
			<KCombobox.Control class="glim-field w-full" aria-label={props["aria-label"]}>
				<Icon name="search" class="text-text-secondary" />
				<KCombobox.Input aria-labelledby={props["aria-labelledby"]} />
				<KCombobox.Trigger class="glim-icon-btn -me-1" aria-label="Show languages">
					<KCombobox.Icon class="inline-flex">
						<Icon name="chevron-down" />
					</KCombobox.Icon>
				</KCombobox.Trigger>
			</KCombobox.Control>
			<KCombobox.Portal>
				<KCombobox.Content class="glim-menu">
					<KCombobox.Listbox class="outline-none" />
					<Show when={filtered().length === 0}>
						<p class="glim-menu-empty m-0">{props.emptyLabel ?? "No matching language"}</p>
					</Show>
				</KCombobox.Content>
			</KCombobox.Portal>
		</KCombobox>
	);
}
