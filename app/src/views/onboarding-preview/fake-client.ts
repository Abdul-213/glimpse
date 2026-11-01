// Fake main process for the dev-only onboarding preview (GLIM-45, GLIM-76): in-memory state so
// the real OnboardingApp renders and responds in a plain browser and in headless screenshots.
// Dev-only, never shipped (build-views.ts DEV_ONLY_VIEWS).
import type { ScreenAccessState } from "@glimpse/core";
import type { OnboardingSnapshot, ScreenAccessStatus } from "../../shared/onboarding-rpc.ts";
import type { OnboardingClient, OnboardingPushHandlers, OnboardingRequests } from "../onboarding/client.ts";

export interface PreviewOptions {
	os: "macos" | "windows";
	/** Screen access: not-determined | denied | denied-opened | lost | lost-opened | granted. */
	access: string;
}

function accessFrom(os: PreviewOptions["os"], access: string): ScreenAccessStatus {
	if (os === "windows") return { state: "not-needed", settingsOpened: false, canRestart: false };
	const [state, opened] = access.split("-opened") as [string, string | undefined];
	const known: ScreenAccessState[] = ["not-determined", "denied", "lost", "granted"];
	const s = (known as string[]).includes(state) ? (state as ScreenAccessState) : "not-determined";
	return { state: s, settingsOpened: opened !== undefined, canRestart: true };
}

export function fakeOnboardingClient(opts: PreviewOptions): OnboardingClient {
	let access = accessFrom(opts.os, opts.access);
	let handlers: OnboardingPushHandlers | null = null;
	const push = () => handlers?.screenAccessChanged(access);

	const snapshot = (): OnboardingSnapshot => ({
		app: { name: "Glimpse", version: "0.0.1", platform: opts.os, electrobun: "2.0.6-beta.2", bun: "1.4.4" },
		mode: "screen-access",
		screenAccess: access,
	});

	const request: OnboardingRequests = {
		getSnapshot: async () => snapshot(),
		requestScreenAccess: async () => {
			access = access.state === "not-determined" ? { ...access, state: "denied" } : { ...access, settingsOpened: true };
			push();
			return access;
		},
		openScreenAccessSettings: async () => {
			access = { ...access, settingsOpened: true };
			push();
			return access;
		},
		refreshScreenAccess: async () => access,
		restartApp: async () => {
			access = { ...access, state: "granted" };
			push();
			return { ok: true };
		},
		openInstallGuide: async () => ({ ok: true }),
	};

	return {
		request,
		listen: (h) => {
			handlers = h;
		},
		close: () => {
			document.body.dataset["closed"] = "true";
		},
	};
}
