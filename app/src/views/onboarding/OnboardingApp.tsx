import { Banner, Button, InlineMessage } from "@glimpse/ui";
import { createSignal, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { OnboardingSnapshot, ScreenAccessStatus, SetupState } from "../../shared/onboarding-rpc.ts";
import type { OnboardingClient } from "./client.ts";
import { type ScreenAccessAction, screenAccessCopy } from "./copy.ts";
import { SetupFlow } from "./SetupFlow.tsx";
import { StepFrame } from "./StepFrame.tsx";
import { SCREEN_ACCESS_LEAD, SCREEN_ACCESS_TITLE, ScreenAccessStep } from "./steps/ScreenAccessStep.tsx";

export interface OnboardingAppProps {
	client: OnboardingClient;
	/** Called once the snapshot arrives (index.tsx applies the platform to <html>). */
	onReady?: (platform: "macos" | "windows" | "linux") => void;
}

/**
 * The onboarding window (GLIM-45, GLIM-76; docs/design/flows/onboarding.html). A mirror of
 * main's state: it renders the snapshot and pushes, and sends intents back. `setup` mode is
 * first-run setup; `screen-access` mode is the permission step alone.
 */
export function OnboardingApp(props: OnboardingAppProps): JSX.Element {
	const { client } = props;
	const [snap, setSnap] = createSignal<OnboardingSnapshot | null>(null);
	const [access, setAccess] = createSignal<ScreenAccessStatus | null>(null);
	const [setup, setSetup] = createSignal<SetupState | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const [loadError, setLoadError] = createSignal<string | null>(null);
	const [busy, setBusy] = createSignal(false);

	client.listen({
		screenAccessChanged: (s) => setAccess(s),
		downloadsChanged: (d) => {
			const s = setup();
			if (s) setSetup({ ...s, downloads: d });
		},
		hotkeysChanged: (status) => {
			const s = setup();
			if (s) setSetup({ ...s, hotkeys: { ...s.hotkeys, status } });
		},
	});

	const refresh = () => {
		void client.request
			.refreshScreenAccess()
			.then(setAccess)
			.catch(() => {});
	};

	onMount(async () => {
		try {
			const s = await client.request.getSnapshot();
			setSnap(s);
			setAccess(s.screenAccess);
			setSetup(s.setup);
			props.onReady?.(s.app.platform);
		} catch {
			setLoadError("Glimpse didn't answer. Close this window and open it again from the menu bar.");
		}
		// Coming back from System Settings: check again at once.
		window.addEventListener("focus", refresh);
	});
	onCleanup(() => window.removeEventListener("focus", refresh));

	const run = async (action: ScreenAccessAction) => {
		setError(null);
		setBusy(true);
		try {
			switch (action) {
				case "request":
					setAccess(await client.request.requestScreenAccess());
					break;
				case "open-settings":
					setAccess(await client.request.openScreenAccessSettings());
					break;
				case "restart": {
					const r = await client.request.restartApp();
					if (!r.ok) setError(r.message);
					break;
				}
				case "done":
					client.close();
					break;
			}
		} catch {
			setError("Glimpse didn't answer. Try again.");
		} finally {
			setBusy(false);
		}
	};

	const guide = () => {
		void client.request.openInstallGuide().then((r) => {
			if (!r.ok) setError(r.message);
		});
	};

	return (
		<Switch
			fallback={
				<Show when={loadError()}>
					{(m) => (
						<div class="onboarding-shell h-dvh p-6">
							<Banner tone="danger" title="Setup can't load" live>
								{m()}
							</Banner>
						</div>
					)}
				</Show>
			}
		>
			<Match when={snap()?.mode === "setup" && setup() && access()}>
				<SetupFlow
					client={client}
					platform={snap()?.app.platform ?? "macos"}
					setup={setup() as SetupState}
					access={access() as ScreenAccessStatus}
					onSetup={setSetup}
					onDownloads={(d) => {
						const s = setup();
						if (s) setSetup({ ...s, downloads: d });
					}}
					onAccess={setAccess}
					onGuide={guide}
				/>
			</Match>
			<Match when={snap()?.mode === "screen-access" && access()}>
				{(a) => {
					const copy = () => screenAccessCopy(a());
					return (
						<StepFrame
							title={SCREEN_ACCESS_TITLE}
							lead={SCREEN_ACCESS_LEAD}
							start={
								<Show when={copy().primary.action !== "done"}>
									<Button onClick={() => client.close()}>Not now</Button>
								</Show>
							}
							middle={<Show when={error()}>{(m) => <InlineMessage tone="danger">{m()}</InlineMessage>}</Show>}
							end={
								<>
									<Show when={copy().secondary}>
										{(s) => (
											<Button disabled={busy()} onClick={() => void run(s().action)}>
												{s().label}
											</Button>
										)}
									</Show>
									<Button variant="primary" disabled={busy()} onClick={() => void run(copy().primary.action)}>
										{copy().primary.label}
									</Button>
								</>
							}
						>
							<ScreenAccessStep status={a()} onGuide={guide} />
						</StepFrame>
					);
				}}
			</Match>
		</Switch>
	);
}
