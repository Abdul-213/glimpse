import { type JSX, Show } from "solid-js";
import { Icon, type IconName } from "./Icon.tsx";

export type BannerTone = "info" | "success" | "warning" | "danger";

const ICON: Record<BannerTone, IconName> = { info: "info", success: "success", warning: "warning", danger: "alert" };

export interface BannerProps {
	tone: BannerTone;
	title: JSX.Element;
	children?: JSX.Element;
	actions?: JSX.Element;
	/** Announce when it appears (status changes such as "Permission granted"). */
	live?: boolean;
}

/**
 * Settings and onboarding notice (DESIGN.md Banner): status icon and words carry the
 * status, never a coloured side stripe. Popups use StateMessage instead.
 */
export function Banner(props: BannerProps): JSX.Element {
	return (
		<div class="glim-banner" role={props.live ? (props.tone === "danger" ? "alert" : "status") : undefined}>
			<Icon name={ICON[props.tone]} class={`mt-0.5 glim-tone-${props.tone}`} />
			<div class="flex min-w-0 flex-1 flex-col gap-1">
				<p class="m-0 text-body font-semibold">{props.title}</p>
				<Show when={props.children}>
					<p class="m-0 max-w-measure text-body text-text-secondary">{props.children}</p>
				</Show>
				<Show when={props.actions}>
					<div class="mt-2 flex flex-wrap gap-2">{props.actions}</div>
				</Show>
			</div>
		</div>
	);
}
