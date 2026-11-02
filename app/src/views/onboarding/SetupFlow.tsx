import type { HotkeyAction, OnboardingStep } from "@glimpse/core";
import {
	Banner,
	Button,
	fromStoredHotkey,
	hotkeyLabel,
	InlineMessage,
	TextButton,
	Switch as Toggle,
	type UiPlatform,
} from "@glimpse/ui";
import { createSignal, type JSX, Match, Show, Switch } from "solid-js";
import type { DownloadsSnapshot, ScreenAccessStatus, SetupState } from "../../shared/onboarding-rpc.ts";
import type { OnboardingClient } from "./client.ts";
import { type ScreenAccessAction, screenAccessCopy } from "./copy.ts";
import { StepFrame } from "./StepFrame.tsx";
import { StepStrip, stripOf } from "./StepStrip.tsx";
import { DownloadsStep } from "./steps/DownloadsStep.tsx";
import { LanguageStep } from "./steps/LanguageStep.tsx";
import { SCREEN_ACCESS_LEAD, SCREEN_ACCESS_TITLE, ScreenAccessStep } from "./steps/ScreenAccessStep.tsx";
import { ShortcutsStep } from "./steps/ShortcutsStep.tsx";

export interface SetupFlowProps {
	client: OnboardingClient;
	platform: "macos" | "windows" | "linux";
	setup: SetupState;
	access: ScreenAccessStatus;
	onSetup: (s: SetupState) => void;
	onDownloads: (d: DownloadsSnapshot) => void;
	onAccess: (s: ScreenAccessStatus) => void;
	onGuide: () => void;
}

/**
 * First-run setup (GLIM-76; docs/design/flows/onboarding.html O0–O5, R2): welcome, screen
 * access (macOS), translate into, downloads, shortcuts, done. Each step is saved as it is
 * reached, so quitting midway resumes there. Every step can be skipped.
 */
export function SetupFlow(props: SetupFlowProps): JSX.Element {
	const { client } = props;
	const [error, setError] = createSignal<string | null>(null);
	const [busy, setBusy] = createSignal(false);
	const [hotkeyErrors, setHotkeyErrors] = createSignal<Partial<Record<HotkeyAction, string>>>({});
	const [launchAtLogin, setLaunchAtLogin] = createSignal(true);
	const [resumedNote, setResumedNote] = createSignal(props.setup.resumed);

	const s = () => props.setup;
	const step = () => s().step;
	const mac = () => props.platform === "macos";
	const uiPlatform = (): UiPlatform => (props.platform === "macos" ? "macos" : "windows");
	const trayPlace = () => (mac() ? "the menu bar" : "the notification area");
	const stepCount = () => stripOf(s().steps).length;

	const attempt = async (fn: () => Promise<void>) => {
		setError(null);
		setBusy(true);
		try {
			await fn();
		} catch {
			setError("Glimpse didn't answer. Try again.");
		} finally {
			setBusy(false);
		}
	};

	const go = (target: OnboardingStep) =>
		attempt(async () => {
			setResumedNote(false);
			props.onSetup(await client.request.goToStep({ step: target }));
			document.getElementById("step-title")?.focus();
		});
	const index = () => s().steps.indexOf(step());
	const next = () => go(s().steps[Math.min(s().steps.length - 1, index() + 1)] ?? step());
	const back = () => go(s().steps[Math.max(0, index() - 1)] ?? step());

	const skipSetup = () =>
		attempt(async () => {
			await client.request.skipSetup();
			client.close();
		});

	const finish = () =>
		attempt(async () => {
			const r = await client.request.finishSetup(
				s().loginItem.supported ? { launchAtLogin: launchAtLogin() } : { launchAtLogin: s().loginItem.enabled },
			);
			if (r.ok) client.close();
			else setError(r.message);
		});

	const screenAction = (action: ScreenAccessAction) =>
		attempt(async () => {
			switch (action) {
				case "request":
					props.onAccess(await client.request.requestScreenAccess());
					break;
				case "open-settings":
					props.onAccess(await client.request.openScreenAccessSettings());
					break;
				case "restart": {
					const r = await client.request.restartApp();
					if (!r.ok) setError(r.message);
					break;
				}
				case "done":
					await next();
					break;
			}
		});

	const toggleLanguage = (code: string, on: boolean) =>
		attempt(async () => {
			const picked = s().downloads.picked.filter((c) => c !== code);
			props.onDownloads(await client.request.pickLanguages({ languages: on ? [...picked, code] : picked }));
		});
	const download = () => attempt(async () => props.onDownloads(await client.request.downloadLanguages()));
	const stopDownloads = () => attempt(async () => props.onDownloads(await client.request.cancelDownloads()));
	const findPacks = () => attempt(async () => props.onDownloads(await client.request.loadPackCatalogue()));

	const setHotkey = (action: HotkeyAction, hotkey: string | null) =>
		attempt(async () => {
			const r = await client.request.setHotkey({ action, hotkey, swap: true });
			if (r.ok) {
				setHotkeyErrors({});
				props.onSetup({ ...s(), hotkeys: { bindings: r.bindings, status: r.status } });
			} else setHotkeyErrors({ ...hotkeyErrors(), [action]: r.message });
		});

	const needsDownload = () =>
		s().downloads.languages.some((l) => s().downloads.picked.includes(l.code) && l.state === "available");
	const targetName = () => s().targets.find((t) => t.code === s().target)?.name ?? s().target;
	const shortcut = (action: "snip" | "live") => {
		const h = fromStoredHotkey(s().hotkeys.bindings[action]);
		return h ? hotkeyLabel(h, uiPlatform()) : null;
	};

	/** Footer download progress while packs download (flows O4a: "Downloading 61%"). */
	const footerProgress = () => (
		<Show when={s().downloads.active}>
			{(a) => {
				const pct = () => (a().total > 0 ? Math.floor((a().done / a().total) * 100) : 0);
				return (
					<span class="flex items-center gap-2 text-label text-text-secondary tabular-nums">
						<span>Downloading {pct()}%</span>
						<span
							class="glim-progress-track block w-16"
							role="progressbar"
							aria-label="Downloading language packs"
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={pct()}
						>
							<span class="glim-progress-fill block" style={{ width: `${pct()}%` }} />
						</span>
					</span>
				);
			}}
		</Show>
	);
	const middle = () => (
		<Show when={error()} fallback={footerProgress()}>
			{(m) => <InlineMessage tone="danger">{m()}</InlineMessage>}
		</Show>
	);

	const header = () => (
		<Show when={step() !== "welcome" && step() !== "done"}>
			<StepStrip steps={s().steps} current={step()} onSelect={(t) => void go(t)} />
		</Show>
	);
	const resumed = () => (
		<Show when={resumedNote()}>
			<p class="m-0 text-label text-text-secondary" role="status">
				Welcome back. Pick up where you left off.
			</p>
		</Show>
	);
	const backButton = () => (
		<Button disabled={busy()} onClick={() => void back()}>
			Back
		</Button>
	);
	const skipStep = (label = "Skip") => (
		<TextButton disabled={busy()} onClick={() => void next()}>
			{label}
		</TextButton>
	);

	return (
		<Switch>
			<Match when={step() === "welcome"}>
				<StepFrame
					title="Welcome to Glimpse"
					lead="Select any part of your screen and read it in your language. Text is read and translated on this computer."
					start={<TextButton onClick={() => void skipSetup()}>Skip setup</TextButton>}
					middle={middle()}
					end={
						<Button variant="primary" disabled={busy()} onClick={() => void next()}>
							Start
						</Button>
					}
				>
					{resumed()}
					<p class="m-0 max-w-measure text-body text-text-secondary">
						Setup has {stepCount()} short steps and one download. You can skip any of them and finish later from{" "}
						{trayPlace()}.
					</p>
					<Show when={!mac()}>
						<Banner
							tone="info"
							title="Saw a SmartScreen warning?"
							actions={<TextButton onClick={() => props.onGuide()}>About unsigned builds</TextButton>}
						>
							This build of Glimpse isn't signed yet, so Windows warned you before opening it. That's expected for this
							open-source release; the install guide explains each warning.
						</Banner>
					</Show>
				</StepFrame>
			</Match>

			<Match when={step() === "screen-access"}>
				{(() => {
					const copy = () => screenAccessCopy(props.access);
					return (
						<StepFrame
							header={header()}
							title={SCREEN_ACCESS_TITLE}
							lead={SCREEN_ACCESS_LEAD}
							start={
								<>
									{backButton()}
									<Show when={copy().primary.action !== "done"}>{skipStep("Skip for now")}</Show>
								</>
							}
							middle={middle()}
							end={
								<>
									<Show when={copy().secondary}>
										{(x) => (
											<Button disabled={busy()} onClick={() => void screenAction(x().action)}>
												{x().label}
											</Button>
										)}
									</Show>
									<Button variant="primary" disabled={busy()} onClick={() => void screenAction(copy().primary.action)}>
										{copy().primary.label}
									</Button>
								</>
							}
						>
							{resumed()}
							<ScreenAccessStep status={props.access} onGuide={props.onGuide} />
						</StepFrame>
					);
				})()}
			</Match>

			<Match when={step() === "language"}>
				<StepFrame
					header={header()}
					title="Translate into"
					lead="Pick the language you want to read. You can change it any time in Settings."
					start={
						<>
							{backButton()}
							{skipStep()}
						</>
					}
					middle={middle()}
					end={
						<Button variant="primary" disabled={busy()} onClick={() => void next()}>
							Continue
						</Button>
					}
				>
					{resumed()}
					<LanguageStep
						target={s().target}
						targets={s().targets}
						suggested={s().suggestedTargets}
						systemLanguage={s().suggestedTargets[1]}
						onChange={(code) =>
							void attempt(async () => props.onSetup(await client.request.setTarget({ language: code })))
						}
					/>
				</StepFrame>
			</Match>

			<Match when={step() === "downloads"}>
				<StepFrame
					header={header()}
					title="Languages to read"
					lead={`Glimpse translates on this computer with a language pack for each language you read into ${targetName()}. After the download it works offline.`}
					start={
						<>
							{backButton()}
							<Show when={needsDownload() || !s().downloads.active}>{skipStep("Skip for now")}</Show>
						</>
					}
					middle={middle()}
					end={
						<Show
							when={needsDownload()}
							fallback={
								<Button variant="primary" disabled={busy()} onClick={() => void next()}>
									Continue
								</Button>
							}
						>
							<Button variant="primary" disabled={busy()} onClick={() => void download()}>
								Download
							</Button>
						</Show>
					}
				>
					{resumed()}
					<DownloadsStep
						downloads={s().downloads}
						busy={busy()}
						onToggle={(code, on) => void toggleLanguage(code, on)}
						onFindPacks={() => void findPacks()}
						onStop={() => void stopDownloads()}
					/>
				</StepFrame>
			</Match>

			<Match when={step() === "shortcuts"}>
				<StepFrame
					header={header()}
					title="Shortcuts"
					lead="These work from any app, even fullscreen games. Press one now to try it; Esc brings you back."
					start={backButton()}
					middle={middle()}
					end={
						<Button variant="primary" disabled={busy()} onClick={() => void next()}>
							Continue
						</Button>
					}
				>
					{resumed()}
					<ShortcutsStep
						bindings={s().hotkeys.bindings}
						status={s().hotkeys.status}
						platform={uiPlatform()}
						errors={hotkeyErrors()}
						onChange={(action, hotkey) => void setHotkey(action, hotkey)}
					/>
				</StepFrame>
			</Match>

			<Match when={step() === "done"}>
				<StepFrame
					title="You're set"
					lead={`Glimpse lives in ${trayPlace()}. There's no main window: press a shortcut or use its menu.`}
					start={backButton()}
					middle={middle()}
					end={
						<Button variant="primary" disabled={busy()} onClick={() => void finish()}>
							Finish
						</Button>
					}
				>
					<div class="glim-group">
						<Show when={shortcut("snip")}>
							{(k) => (
								<div class="glim-row">
									<span class="glim-label min-w-0 flex-1">Snip a region</span>
									<kbd class="glim-kbd">{k()}</kbd>
								</div>
							)}
						</Show>
						<Show when={shortcut("live")}>
							{(k) => (
								<div class="glim-row">
									<span class="glim-label min-w-0 flex-1">Pin a region with Live</span>
									<kbd class="glim-kbd">{k()}</kbd>
								</div>
							)}
						</Show>
						<Show when={s().loginItem.supported}>
							<div class="glim-row">
								<Toggle
									layout="row"
									label={mac() ? "Open at login" : "Start when I sign in"}
									checked={launchAtLogin()}
									onChange={setLaunchAtLogin}
								/>
							</div>
						</Show>
					</div>
					<Show when={s().downloads.active}>
						{(a) => (
							<p class="m-0 text-label text-text-secondary tabular-nums" role="status">
								Language packs are still downloading ({a().total > 0 ? Math.floor((a().done / a().total) * 100) : 0}%).
								Snip works for languages that are ready; the rest join as they finish.
							</p>
						)}
					</Show>
					<Show when={!mac()}>
						<p class="m-0 max-w-measure text-label text-text-secondary">
							Windows may hide new icons behind the ^ arrow in the notification area. Drag Glimpse out to keep it in
							view.
						</p>
					</Show>
				</StepFrame>
			</Match>
		</Switch>
	);
}
