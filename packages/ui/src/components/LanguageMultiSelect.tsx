import { createMemo, createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { filterLanguages, type LanguageOption } from "../language-filter.ts";
import { Icon } from "./Icon.tsx";

export interface MultiLanguageOption extends LanguageOption {
	/** Trailing note in `text-secondary` ("Can't be detected reliably"). */
	readonly note?: string;
}

export interface LanguageOptionGroup {
	readonly key: string;
	/** Script name ("Latin", "Cyrillic", "Other scripts"). */
	readonly label: string;
	readonly options: readonly MultiLanguageOption[];
}

export interface LanguageMultiSelectProps {
	groups: readonly LanguageOptionGroup[];
	/** Selected codes, in the order they were added. */
	value: readonly string[];
	onChange: (codes: string[]) => void;
	"aria-labelledby"?: string;
	"aria-describedby"?: string;
	placeholder?: string;
	emptyLabel?: string;
	/** Visible list height. Default 15rem. */
	listHeight?: string;
	disabled?: boolean;
}

/**
 * Searchable multi-select for languages, grouped by script (Settings › Languages, GLIM-68).
 * Chips for the chosen languages sit in the search field; the list below stays open, so it
 * reads as part of the settings pane rather than a menu. The same matching as LanguagePicker
 * (UI name, own name, code, accents ignored).
 *
 * Keyboard: type to filter; Up/Down move through the list; Space or Enter toggles the
 * highlighted language; Backspace in an empty field removes the last chip; Esc clears the search.
 */
export function LanguageMultiSelect(props: LanguageMultiSelectProps): JSX.Element {
	const id = createUniqueId();
	const listId = `lms-${id}`;
	const [query, setQuery] = createSignal("");
	const [active, setActive] = createSignal<string | null>(null);

	const selected = createMemo(() => new Set(props.value));
	const byCode = createMemo(() => {
		const m = new Map<string, MultiLanguageOption>();
		for (const g of props.groups) for (const o of g.options) m.set(o.code, o);
		return m;
	});
	const visibleGroups = createMemo(() =>
		props.groups
			.map((g) => ({ ...g, options: filterLanguages(g.options, query()) }))
			.filter((g) => g.options.length > 0),
	);
	const flat = createMemo(() => visibleGroups().flatMap((g) => g.options.filter((o) => !o.disabled)));
	const optionId = (code: string) => `${listId}-${code}`;

	const toggle = (code: string) => {
		if (props.disabled) return;
		const next = selected().has(code) ? props.value.filter((c) => c !== code) : [...props.value, code];
		props.onChange(next);
	};

	const move = (delta: number) => {
		const items = flat();
		if (items.length === 0) return;
		const i = items.findIndex((o) => o.code === active());
		const next = items[Math.max(0, Math.min(items.length - 1, i < 0 ? 0 : i + delta))];
		if (!next) return;
		setActive(next.code);
		document.getElementById(optionId(next.code))?.scrollIntoView({ block: "nearest" });
	};

	const onKeyDown = (e: KeyboardEvent) => {
		switch (e.key) {
			case "ArrowDown":
				move(1);
				break;
			case "ArrowUp":
				move(-1);
				break;
			case "Home":
				if (query() !== "") return;
				move(-flat().length);
				break;
			case "End":
				if (query() !== "") return;
				move(flat().length);
				break;
			case "Enter":
			case " ": {
				// While searching, Space types (names like "Haitian Creole"); Enter always toggles.
				const code = active();
				if (!code || (e.key === " " && query() !== "")) return;
				toggle(code);
				break;
			}
			case "Backspace": {
				if (query() !== "" || props.value.length === 0) return;
				props.onChange(props.value.slice(0, -1));
				break;
			}
			case "Escape":
				if (query() === "") return;
				setQuery("");
				break;
			default:
				return;
		}
		e.preventDefault();
	};

	return (
		<div class="glim-multiselect" data-disabled={props.disabled ? "" : undefined}>
			<div class="glim-field glim-multiselect-field">
				<Icon name="search" class="text-text-secondary" />
				<For each={props.value}>
					{(code) => {
						const option = () => byCode().get(code);
						return (
							<span class="glim-chip" lang={code}>
								<span dir="auto">{option()?.name ?? code}</span>
								<button
									type="button"
									class="glim-chip-remove"
									aria-label={`Remove ${option()?.name ?? code}`}
									disabled={props.disabled}
									onClick={() => toggle(code)}
								>
									<Icon name="close" size={12} />
								</button>
							</span>
						);
					}}
				</For>
				<input
					type="text"
					role="combobox"
					aria-expanded="true"
					aria-autocomplete="list"
					aria-controls={listId}
					aria-activedescendant={active() ? optionId(active() as string) : undefined}
					aria-labelledby={props["aria-labelledby"]}
					aria-describedby={props["aria-describedby"]}
					placeholder={props.value.length === 0 ? (props.placeholder ?? "Search languages") : ""}
					value={query()}
					disabled={props.disabled}
					spellcheck={false}
					autocomplete="off"
					onInput={(e) => {
						setQuery(e.currentTarget.value);
						setActive(flat()[0]?.code ?? null);
					}}
					onKeyDown={onKeyDown}
				/>
			</div>
			<div
				id={listId}
				role="listbox"
				aria-multiselectable="true"
				aria-labelledby={props["aria-labelledby"]}
				class="glim-multiselect-list"
				style={{ "max-height": props.listHeight ?? "15rem" }}
			>
				<For each={visibleGroups()}>
					{(group) => (
						// biome-ignore lint/a11y/useSemanticElements: ARIA listbox option groups are role="group"; a fieldset isn't allowed inside a listbox.
						<div role="group" aria-labelledby={`${listId}-g-${group.key}`}>
							<div id={`${listId}-g-${group.key}`} class="glim-multiselect-heading" role="presentation">
								{group.label}
							</div>
							<For each={group.options}>
								{(o) => (
									// biome-ignore lint/a11y/useFocusableInteractive: focus stays in the combobox input (aria-activedescendant).
									// biome-ignore lint/a11y/useKeyWithClickEvents: the input's key handler toggles the active option.
									<div
										id={optionId(o.code)}
										role="option"
										aria-selected={selected().has(o.code) ? "true" : "false"}
										aria-disabled={o.disabled ? "true" : undefined}
										class="glim-multiselect-option"
										data-active={active() === o.code ? "" : undefined}
										onMouseDown={(e) => e.preventDefault()}
										onClick={() => {
											if (o.disabled) return;
											setActive(o.code);
											toggle(o.code);
										}}
									>
										<span class="glim-check" data-checked={selected().has(o.code) ? "" : undefined} aria-hidden="true">
											<Icon name="check" size={12} />
										</span>
										<span class="min-w-0 truncate">{o.name}</span>
										<Show when={o.nativeName && o.nativeName !== o.name}>
											<span class="glim-multiselect-secondary min-w-0 truncate" lang={o.code} dir="auto">
												{o.nativeName}
											</span>
										</Show>
										<Show when={o.note}>
											<span class="glim-multiselect-note">{o.note}</span>
										</Show>
									</div>
								)}
							</For>
						</div>
					)}
				</For>
				<Show when={visibleGroups().length === 0}>
					<p class="glim-menu-empty m-0">{props.emptyLabel ?? "No matching language"}</p>
				</Show>
			</div>
		</div>
	);
}
