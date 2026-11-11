import type { Settings } from "@glimpse/core";
import { Banner, Button, SettingsControlRow, SettingsGroup, SettingsRow, Switch } from "@glimpse/ui";
import { type JSX, Show } from "solid-js";
import type { SettingsState } from "../state.ts";
import { createAction, type Os, osWords, Pane } from "./common.tsx";

const OS_NAME: Record<Os, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

/** Settings › About: version, and the tools for reporting a problem. */
export function AboutPane(props: { state: SettingsState }): JSX.Element {
	const snap = () => props.state.snapshot();
	const s = () => props.state.settings() as Settings;
	const copy = createAction("Copied. Paste it into your bug report.");
	const logs = createAction();
	const setup = createAction();
	const download = createAction();
	const available = () => {
		const u = props.state.updateStatus();
		return u?.state === "available" ? u.release : null;
	};
	const os = () => (snap()?.app.platform ?? "macos") as Os;

	return (
		<Pane title="About">
			<SettingsGroup>
				<SettingsRow
					label={`Glimpse ${snap()?.app.version ?? ""}`}
					description={
						<span class="tabular-nums">
							{OS_NAME[os()]} · Electrobun {snap()?.app.electrobun} · Bun {snap()?.app.bun}
						</span>
					}
				/>
				<Show when={available()}>
					{(release) => (
						<SettingsRow
							label={`Glimpse ${release().version} is available`}
							description={
								<>
									<span class="block">Download it from the release page. Glimpse doesn't update itself.</span>
									{download.view()}
								</>
							}
						>
							<Button
								disabled={download.busy()}
								onClick={() => void download.run(() => props.state.client.request.openUpdatePage())}
							>
								Open download page
							</Button>
						</SettingsRow>
					)}
				</Show>
				<SettingsControlRow>
					<Switch
						label="Check for updates"
						description="Once a day, asks GitHub whether a newer version is out. Nothing from your screen or settings is sent."
						checked={s().updates.check}
						onChange={(v) => void props.state.update({ updates: { check: v } })}
					/>
				</SettingsControlRow>
			</SettingsGroup>

			<Show when={(snap()?.settingsWarnings.length ?? 0) > 0}>
				<div class="mt-5">
					<Banner tone="warning" title="Some settings were reset when Glimpse started">
						{snap()?.settingsWarnings.join(" ")}
					</Banner>
				</div>
			</Show>

			<SettingsGroup title="Setup">
				<SettingsRow
					label="First-run setup"
					description={
						<>
							<span class="block">
								Screen access, the language to translate into, downloads and shortcuts, step by step.
							</span>
							{setup.view()}
						</>
					}
				>
					<Button
						disabled={setup.busy()}
						onClick={() => void setup.run(() => props.state.client.request.openOnboarding())}
					>
						{s().onboarding.completed ? "Run setup again" : "Finish setup"}
					</Button>
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup
				title="Troubleshooting"
				footer="Diagnostics and logs never include text from your screen or API keys."
			>
				<SettingsRow
					label="Diagnostics"
					description={
						<>
							<span class="block">
								Version, settings, displays and recent log lines, ready to paste into a bug report.
							</span>
							{copy.view()}
						</>
					}
				>
					<Button
						disabled={copy.busy()}
						onClick={() => void copy.run(() => props.state.client.request.copyDiagnostics())}
					>
						Copy diagnostics
					</Button>
				</SettingsRow>
				<SettingsRow
					label="Log files"
					description={
						<>
							<span class="block">Opens the logs folder in {osWords(os()).fileManager}.</span>
							{logs.view()}
						</>
					}
				>
					<Button disabled={logs.busy()} onClick={() => void logs.run(() => props.state.client.request.openLogs())}>
						Open logs folder
					</Button>
				</SettingsRow>
				<SettingsControlRow>
					<Switch
						label="Detailed logging"
						description="Writes more detail to the log. Turn it on when you are asked to reproduce a problem."
						checked={s().diagnostics.logLevel === "debug"}
						onChange={(v) => void props.state.update({ diagnostics: { logLevel: v ? "debug" : "info" } })}
					/>
				</SettingsControlRow>
			</SettingsGroup>
		</Pane>
	);
}
