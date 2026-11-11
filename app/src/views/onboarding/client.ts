// What the onboarding view needs from the main process. index.tsx implements it over RPC; the
// dev-only preview (views/onboarding-preview) implements it with fake data for screenshots.
import type { DownloadsSnapshot, OnboardingRPC, ScreenAccessStatus } from "../../shared/onboarding-rpc.ts";
import type { HotkeyStatus } from "../../shared/settings-rpc.ts";

type Requests = OnboardingRPC["bun"]["requests"];

export type OnboardingRequests = {
	[K in keyof Requests]: Requests[K]["params"] extends undefined
		? () => Promise<Requests[K]["response"]>
		: (params: Requests[K]["params"]) => Promise<Requests[K]["response"]>;
};

export interface OnboardingPushHandlers {
	screenAccessChanged: (s: ScreenAccessStatus) => void;
	downloadsChanged: (d: DownloadsSnapshot) => void;
	hotkeysChanged: (s: HotkeyStatus) => void;
}

export interface OnboardingClient {
	readonly request: OnboardingRequests;
	listen(handlers: OnboardingPushHandlers): void;
	close(): void;
}
