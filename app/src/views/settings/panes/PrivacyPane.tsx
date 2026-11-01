import type { Settings } from "@glimpse/core";
import { Button, Select, SettingsControlRow, SettingsGroup, SettingsRow, Switch } from "@glimpse/ui";
import type { JSX } from "solid-js";
import type { SettingsState } from "../state.ts";
import { createAction, numberOptions, type Os, Pane } from "./common.tsx";

const IDLE = [
	{ value: 5, label: "After 5 minutes idle" },
	{ value: 15, label: "After 15 minutes idle" },
	{ value: 60, label: "After an hour idle" },
	{ value: 0, label: "Only when Glimpse quits" },
];

/** Settings › Privacy: Private mode default, the translation cache, and capture visibility. */
export function PrivacyPane(props: { state: SettingsState }): JSX.Element {
	const s = () => props.state.settings() as Settings;
	const os = () => (props.state.snapshot()?.app.platform ?? "macos") as Os;
	const clear = createAction("Cache cleared.");

	return (
		<Pane title="Privacy">
			<SettingsGroup title="Private mode">
				<SettingsControlRow>
					<Switch
						label="Start every Snip and Live in Private mode"
						description="Private sessions keep their translations only until they end. You can still switch Private on or off from the tray or a popup."
						checked={s().privacy.privateByDefault}
						onChange={(v) => void props.state.update({ privacy: { privateByDefault: v } })}
					/>
				</SettingsControlRow>
			</SettingsGroup>

			<SettingsGroup
				title="Translation memory"
				footer="Glimpse remembers recent translations in memory so repeated text appears at once. It is never written to disk."
			>
				<SettingsRow label="Forget translations">
					{(ids) => (
						<div class="w-56">
							<Select
								aria-labelledby={ids.labelId}
								value={String(s().privacy.clearCacheAfterIdleMinutes)}
								options={numberOptions(IDLE, s().privacy.clearCacheAfterIdleMinutes, (n) => `After ${n} minutes idle`)}
								onChange={(v) => void props.state.update({ privacy: { clearCacheAfterIdleMinutes: Number(v) } })}
							/>
						</div>
					)}
				</SettingsRow>
				<SettingsControlRow>
					<Switch
						label={
							os() === "macos" ? "Forget when the screen locks or the Mac sleeps" : "Forget when the PC locks or sleeps"
						}
						checked={s().privacy.clearCacheOnLock}
						onChange={(v) => void props.state.update({ privacy: { clearCacheOnLock: v } })}
					/>
				</SettingsControlRow>
				<SettingsRow label="Forget now" description={clear.view()}>
					<Button disabled={clear.busy()} onClick={() => void clear.run(() => props.state.client.request.clearCache())}>
						Clear translations
					</Button>
				</SettingsRow>
			</SettingsGroup>

			{/* GLIM-98 replaces this placeholder with a real setting (default on). */}
			<SettingsGroup title="Screen capture">
				<SettingsControlRow>
					<Switch
						label="Hide Glimpse from screenshots and screen sharing"
						description={
							os() === "macos"
								? "Glimpse windows stay out of screenshots, recordings and screen sharing. On macOS 15 and later this is best effort. A choice to show them is coming."
								: "Glimpse windows stay out of screenshots, recordings and screen sharing. A choice to show them is coming."
						}
						checked
						disabled
					/>
				</SettingsControlRow>
			</SettingsGroup>
		</Pane>
	);
}
