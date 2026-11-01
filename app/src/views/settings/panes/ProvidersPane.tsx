import { Banner, LocalIndicator, SettingsGroup, SettingsRow } from "@glimpse/ui";
import { type JSX, Show } from "solid-js";
import type { ProviderSummary } from "../../../shared/settings-rpc.ts";
import type { SettingsState } from "../state.ts";
import { type Os, osWords, Pane } from "./common.tsx";

function names(list: readonly ProviderSummary[]): string {
	return list.map((p) => p.name).join(", then ");
}

/**
 * Settings › Providers. Local engines only for now: what reads and translates, and that it
 * stays on this computer. Cloud providers and API keys (GLIM-75) go in the marked slot below.
 */
export function ProvidersPane(props: { state: SettingsState }): JSX.Element {
	const snap = () => props.state.snapshot();
	const os = () => (snap()?.app.platform ?? "macos") as Os;
	const ocr = () => snap()?.providers.ocr ?? null;
	const translation = () => snap()?.providers.translation ?? [];

	return (
		<Pane title="Providers">
			<SettingsGroup
				title="On this computer"
				footer={`Text from your screen is read and translated on ${osWords(os()).computer}. Nothing is sent anywhere.`}
			>
				<SettingsRow label="Read text with" description={ocr()?.name ?? "No text reader is installed in this build."}>
					<Show when={ocr()}>
						<LocalIndicator />
					</Show>
				</SettingsRow>
				<SettingsRow
					label="Translate with"
					description={translation().length > 0 ? names(translation()) : "No translator is installed in this build."}
				>
					<Show when={translation().length > 0}>
						<LocalIndicator />
					</Show>
				</SettingsRow>
			</SettingsGroup>

			{/* ── GLIM-75 slot: cloud providers and API keys ─────────────────────────────────
			    The provider list (radio per task, egress badge on cloud ones), SecretField per
			    key with Test key, and the "Translate with ‹Provider›?" confirm go here. Keys
			    live in the OS keychain (services/secrets.ts); the view never reads one back. */}
			<section aria-labelledby="cloud-heading" class="mt-5 flex flex-col">
				<h2 id="cloud-heading" class="m-0 mb-2 text-heading">
					Cloud providers
				</h2>
				<Banner tone="info" title="Not available yet">
					A later version lets you add your own API key for a cloud service. Keys will be kept in{" "}
					{osWords(os()).keychain}, and every cloud result will be marked.
				</Banner>
			</section>
		</Pane>
	);
}
