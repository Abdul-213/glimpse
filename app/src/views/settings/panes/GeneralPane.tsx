import type { LanguageCode, Settings } from "@glimpse/core";
import { type LanguageOption, LanguagePicker, SegmentedControl, Select, SettingsGroup, SettingsRow } from "@glimpse/ui";
import { createMemo, type JSX } from "solid-js";
import type { SettingsState } from "../state.ts";
import { numberOptions, Pane } from "./common.tsx";

const SENSITIVITY = [
	{ value: 0.01, label: "Small changes" },
	{ value: 0.02, label: "Noticeable changes" },
	{ value: 0.06, label: "Large changes only" },
];

const SETTLE = [
	{ value: 150, label: "150 ms" },
	{ value: 300, label: "300 ms" },
	{ value: 500, label: "500 ms" },
	{ value: 800, label: "800 ms" },
];

export function GeneralPane(props: { state: SettingsState }): JSX.Element {
	const s = () => props.state.settings() as Settings;

	// Target languages: every language with a local translation pack (Bergamot pivots via English).
	const targets = createMemo<LanguageOption[]>(() => {
		const groups = props.state.languages()?.groups ?? [];
		const list = groups
			.flatMap((g) => g.languages)
			.filter((l) => l.localTranslation)
			.map((l) => ({ code: l.code, name: l.name, nativeName: l.nativeName }));
		const current = s().language.target;
		if (!list.some((l) => l.code === current)) list.push({ code: current, name: current, nativeName: "" });
		return list.sort((a, b) => a.name.localeCompare(b.name));
	});

	return (
		<Pane title="General">
			<SettingsGroup title="Translation">
				<SettingsRow label="Translate into" description="Text already in this language is shown as it is.">
					{(ids) => (
						<div class="w-60">
							<LanguagePicker
								options={targets()}
								value={s().language.target}
								onChange={(code) => void props.state.update({ language: { target: code as LanguageCode } })}
								aria-labelledby={ids.labelId}
							/>
						</div>
					)}
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup title="Live" footer="Lower rates use less battery; new text shows up a little later.">
				<SettingsRow label="Checks per second">
					<SegmentedControl
						label="Checks per second"
						value={String(s().live.fps)}
						onChange={(v) => void props.state.update({ live: { fps: Number(v) } })}
						options={["1", "2", "3", "4"].map((v) => ({ value: v, label: v }))}
					/>
				</SettingsRow>
				<SettingsRow label="Read again after" description="Raise it if animated backgrounds cause re-reads.">
					{(ids) => (
						<div class="w-48">
							<Select
								aria-labelledby={ids.labelId}
								value={String(s().live.diffThreshold)}
								options={numberOptions(SENSITIVITY, s().live.diffThreshold, (n) => `Custom (${n * 100}%)`)}
								onChange={(v) => void props.state.update({ live: { diffThreshold: Number(v) } })}
							/>
						</div>
					)}
				</SettingsRow>
				<SettingsRow
					label="Wait for text to settle"
					description="How long the region must stay still before it is read."
				>
					{(ids) => (
						<div class="w-32">
							<Select
								aria-labelledby={ids.labelId}
								value={String(s().live.stabilityMs)}
								options={numberOptions(SETTLE, s().live.stabilityMs, (n) => `${n} ms`)}
								onChange={(v) => void props.state.update({ live: { stabilityMs: Number(v) } })}
							/>
						</div>
					)}
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup title="Motion">
				<SettingsRow
					label="Animations"
					description="Reduced turns off fades and slides. Changed Live text is still marked."
				>
					<SegmentedControl
						label="Animations"
						value={s().appearance.motion}
						onChange={(v) => void props.state.update({ appearance: { motion: v as Settings["appearance"]["motion"] } })}
						options={[
							{ value: "system", label: "System" },
							{ value: "reduced", label: "Reduced" },
							{ value: "full", label: "Full" },
						]}
					/>
				</SettingsRow>
			</SettingsGroup>
		</Pane>
	);
}
