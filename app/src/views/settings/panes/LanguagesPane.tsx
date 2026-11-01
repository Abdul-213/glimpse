import type { LanguageCode, Settings, SourceLanguageChoice } from "@glimpse/core";
import {
	Button,
	LanguageMultiSelect,
	type LanguageOptionGroup,
	SegmentedControl,
	SettingsGroup,
	SettingsRow,
} from "@glimpse/ui";
import { createMemo, createSignal, createUniqueId, type JSX, Show } from "solid-js";
import type { SettingsState } from "../state.ts";
import { Pane } from "./common.tsx";

/**
 * The one note an option shows: what stops it working, most fundamental first. Missing packs
 * aren't noted (almost every language starts without one); Models and the popup offer them.
 */
function noteFor(l: SourceLanguageChoice): string | undefined {
	if (!l.detectable) return "Can't be detected reliably";
	if (!l.localOcr) return "Can't be read on this computer";
	if (!l.localTranslation) return "No offline translation";
	return undefined;
}

/**
 * Settings › Languages (GLIM-68): translate every language, or only a chosen subset. An empty
 * subset means every language, so "Only these" with nothing picked yet changes nothing until
 * the first language is chosen.
 */
export function LanguagesPane(props: { state: SettingsState; onManagePacks: () => void }): JSX.Element {
	const s = () => props.state.settings() as Settings;
	const id = createUniqueId();
	const sources = () => s().language.sources;
	const [onlyChosen, setOnlyChosen] = createSignal(sources().length > 0);
	const mode = () => (onlyChosen() || sources().length > 0 ? "only" : "any");

	const groups = createMemo<LanguageOptionGroup[]>(() => {
		const snap = props.state.languages();
		if (!snap) return [];
		return snap.groups.map((g) => ({
			key: g.key,
			label: g.label,
			options: g.languages.map((l) => ({
				code: l.code,
				name: l.name,
				nativeName: l.nativeName,
				note: noteFor(l),
			})),
		}));
	});

	const installedCount = () => props.state.languages()?.packInstalled.length ?? 0;

	const setSources = (codes: string[]) => void props.state.update({ language: { sources: codes as LanguageCode[] } });

	return (
		<Pane title="Languages">
			<SettingsGroup
				title="Source languages"
				footer="Text in other languages isn't translated. The popup collapses it into a line such as “3 blocks skipped”, which you can open."
			>
				<SettingsRow label="Translate text in">
					<SegmentedControl
						label="Translate text in"
						value={mode()}
						onChange={(v) => {
							setOnlyChosen(v === "only");
							if (v === "any" && sources().length > 0) setSources([]);
						}}
						options={[
							{ value: "any", label: "Any language" },
							{ value: "only", label: "Only these" },
						]}
					/>
				</SettingsRow>
				<Show when={mode() === "only"}>
					<div class="glim-row flex-col items-stretch">
						<span id={`src-${id}`} class="sr-only">
							Source languages
						</span>
						<Show when={groups().length > 0} fallback={<p class="glim-description m-0">Loading languages…</p>}>
							<LanguageMultiSelect
								groups={groups()}
								value={sources()}
								onChange={setSources}
								aria-labelledby={`src-${id}`}
								aria-describedby={`src-${id}-hint`}
								placeholder="Type a language name, in English or in that language"
							/>
						</Show>
						<p id={`src-${id}-hint`} class="glim-description">
							<Show
								when={sources().length > 0}
								fallback="Choose at least one language. Until then, every language is translated."
							>
								{sources().length === 1 ? "1 language chosen." : `${sources().length} languages chosen.`}
							</Show>
						</p>
					</div>
				</Show>
			</SettingsGroup>

			<SettingsGroup title="Language packs">
				<SettingsRow
					label={
						installedCount() === 0
							? "No packs downloaded yet"
							: installedCount() === 1
								? "1 language can be translated offline"
								: `${installedCount()} languages can be translated offline`
					}
					description="Packs translate on this computer. Each one is a separate download."
				>
					<Button onClick={() => props.onManagePacks()}>Manage packs</Button>
				</SettingsRow>
			</SettingsGroup>
		</Pane>
	);
}
