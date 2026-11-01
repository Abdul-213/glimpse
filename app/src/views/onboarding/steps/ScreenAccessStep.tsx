import { Banner, Icon, TextButton } from "@glimpse/ui";
import { type JSX, Show } from "solid-js";
import type { ScreenAccessStatus } from "../../../shared/onboarding-rpc.ts";
import { screenAccessCopy } from "../copy.ts";

export interface ScreenAccessStepProps {
	status: ScreenAccessStatus;
	onGuide: () => void;
}

export const SCREEN_ACCESS_TITLE = "Let Glimpse see your screen";

export const SCREEN_ACCESS_LEAD =
	"macOS asks before any app can read what's on screen. Glimpse only captures the region you select, at the moment you select it.";

/** The status row and guidance of the screen-access step (GLIM-45). The footer is the caller's. */
export function ScreenAccessStep(props: ScreenAccessStepProps): JSX.Element {
	const copy = () => screenAccessCopy(props.status);
	return (
		<>
			<div class="glim-group">
				<div class="glim-row">
					<span class="glim-label min-w-0 flex-1">Screen Recording</span>
					<span
						class="onboarding-status flex items-center gap-1.5 text-label"
						data-tone={copy().tone}
						role="status"
						aria-live="polite"
					>
						<Show when={copy().tone === "success"}>
							<Icon name="check" class="glim-tone-success" />
						</Show>
						<Show when={copy().tone === "warning"}>
							<Icon name="warning" class="glim-tone-warning" />
						</Show>
						{copy().status}
					</span>
				</div>
			</div>

			<Show when={copy().banner}>
				{(b) => (
					<Banner tone={b().tone} title={b().title}>
						{b().body}
					</Banner>
				)}
			</Show>

			<Show when={copy().unsignedNote}>
				<p class="m-0 text-label text-text-secondary">
					Glimpse isn't signed by Apple yet, so macOS may ask again after an update.{" "}
					<TextButton onClick={() => props.onGuide()}>About unsigned builds</TextButton>
				</p>
			</Show>
		</>
	);
}
