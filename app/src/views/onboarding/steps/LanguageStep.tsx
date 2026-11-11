import { LanguagePicker } from "@glimpse/ui";
import { createMemo, For, type JSX, Show } from "solid-js";
import type { LanguageChoice } from "../../../shared/onboarding-rpc.ts";

export interface LanguageStepProps {
	target: string;
	targets: readonly LanguageChoice[];
	suggested: readonly string[];
	onChange: (code: string) => void;
	/** "your system language" next to the OS language. */
	systemLanguage?: string;
}

/**
 * "Translate into" (flows O2): the likely choices as a short radio list (current target, the
 * OS language, English), and a searchable picker for every other language with a local pack.
 */
export function LanguageStep(props: LanguageStepProps): JSX.Element {
	const byCode = createMemo(() => new Map(props.targets.map((t) => [t.code as string, t])));
	const shortList = createMemo(() =>
		props.suggested.map((c) => byCode().get(c)).filter((t): t is LanguageChoice => t !== undefined),
	);
	const others = createMemo(() => props.targets.filter((t) => !props.suggested.includes(t.code)));
	const inShortList = () => props.suggested.includes(props.target);

	return (
		<>
			<fieldset class="glim-group m-0 border-0 p-0">
				<legend class="sr-only">Translate into</legend>
				<For each={shortList()}>
					{(t) => {
						const checked = () => t.code === props.target;
						return (
							<label class="onboarding-choice">
								<input
									type="radio"
									name="target"
									class="sr-only"
									checked={checked()}
									onChange={() => props.onChange(t.code)}
								/>
								<span class="onboarding-radio" data-checked={checked() ? "" : undefined} aria-hidden="true" />
								<span class="flex min-w-0 flex-1 items-baseline gap-2">
									<span class="truncate">{t.name}</span>
									<Show when={t.nativeName && t.nativeName !== t.name}>
										<span class="truncate text-text-secondary" lang={t.code} dir="auto">
											{t.nativeName}
										</span>
									</Show>
								</span>
								<Show when={t.code === props.systemLanguage}>
									<span class="text-label text-text-secondary">Your system language</span>
								</Show>
							</label>
						);
					}}
				</For>
			</fieldset>
			<div class="flex items-center gap-3">
				<span id="other-language" class="glim-label shrink-0">
					Another language
				</span>
				<div class="min-w-0 flex-1">
					<LanguagePicker
						options={others()}
						value={inShortList() ? undefined : props.target}
						onChange={(code) => props.onChange(code)}
						aria-labelledby="other-language"
						placeholder="Search languages"
					/>
				</div>
			</div>
		</>
	);
}
