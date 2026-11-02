import type { LanguageCode, Settings } from "@glimpse/core";
import {
	Button,
	LanguageMultiSelect,
	type LanguageOptionGroup,
	SegmentedControl,
	SettingsGroup,
	SettingsRow,
} from "@glimpse/ui";
import { createMemo, createSignal, createUniqueId, type JSX, onMount, Show } from "solid-js";
import type { SettingsState } from "../state.ts";
import { Pane } from "./common.tsx";
import { identifierPrompt, LANGUAGE_IDENTIFIER_ID, noteFor, waitingForIdentifier } from "./detection-copy.ts";
import { LANGUAGE_IDENTIFIER_FOOTER, ModelRowView } from "./ModelsPane.tsx";

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
	// The language identifier (GLIM-104): its Models row, kept fresh by `modelsChanged`.
	onMount(() => {
		if (!props.state.models()) void props.state.loadModels().catch(() => {});
	});
	const identifier = () => props.state.models()?.rows.find((r) => r.id === LANGUAGE_IDENTIFIER_ID);
	const [identifierError, setIdentifierError] = createSignal<string | undefined>(undefined);
	const chosen = () => {
		const codes = new Set<string>(sources());
		return (props.state.languages()?.groups ?? []).flatMap((g) => g.languages.filter((l) => codes.has(l.code)));
	};
	const waiting = () => waitingForIdentifier(chosen(), identifier());
	const request = props.state.client.request;
	const identifierAct = async (fn: () => Promise<{ ok: boolean; message?: string }>) => {
		const r = await fn();
		setIdentifierError(r.ok ? undefined : r.message);
	};

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
				note: noteFor(l, identifier()),
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

			<Show when={mode() === "only" && (waiting().length > 0 || identifier()?.state.status === "downloading")}>
				<SettingsGroup title="Language detection" footer={LANGUAGE_IDENTIFIER_FOOTER}>
					<Show when={waiting().length > 0}>
						<div class="glim-row">
							<p class="glim-description m-0">{identifierPrompt(waiting())}</p>
						</div>
					</Show>
					<Show when={identifier()}>
						{(row) => (
							<ModelRowView
								row={row()}
								error={identifierError()}
								onDownload={() => void identifierAct(() => request.downloadModel({ id: row().id }))}
								onCancel={() => void identifierAct(() => request.cancelModelDownload({ id: row().id }))}
								onRemove={() => void identifierAct(() => request.removeModel({ id: row().id }))}
							/>
						)}
					</Show>
				</SettingsGroup>
			</Show>

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
