import { BrowserView, BrowserWindow } from "electrobun/main";
import type { OnboardingMode, OnboardingRPC } from "../../shared/onboarding-rpc.ts";
import type { CaptureExclusion } from "./capture-exclusion.ts";
import { createOnboardingHandlers, type OnboardingDeps } from "./onboarding-handlers.ts";

/** How often the open window re-checks Screen Recording (preflight is a cheap local call). */
const SCREEN_ACCESS_POLL_MS = 2000;

/**
 * The onboarding window (GLIM-45, GLIM-76; DESIGN.md Layout > Onboarding: 560 x 480, one
 * step per view). One instance, created on demand, re-activated if already open. Handlers
 * live in onboarding-handlers.ts (tested on Linux); this file wires them to Electrobun and
 * pushes changes to the open view.
 */
export class OnboardingWindow {
	private window: BrowserWindow | null = null;
	private mode: OnboardingMode = "screen-access";
	private cleanup: (() => void)[] = [];

	constructor(
		private readonly deps: OnboardingDeps,
		private readonly exclusion: CaptureExclusion,
	) {}

	get isOpen(): boolean {
		return this.window !== null;
	}

	open(mode: OnboardingMode): void {
		if (this.window) {
			this.window.activate();
			return;
		}
		this.mode = mode;
		const h = createOnboardingHandlers(this.deps, () => this.mode);
		const rpc = BrowserView.defineRPC<OnboardingRPC>({
			maxRequestTime: 30_000,
			handlers: {
				requests: {
					getSnapshot: h.getSnapshot,
					requestScreenAccess: h.requestScreenAccess,
					openScreenAccessSettings: h.openScreenAccessSettings,
					refreshScreenAccess: h.refreshScreenAccess,
					restartApp: h.restartApp,
					openInstallGuide: h.openInstallGuide,
				},
				messages: {
					closeOnboarding: () => this.window?.close(),
				},
			},
		});
		const win = new BrowserWindow({
			title: "Glimpse",
			url: "views://onboarding/index.html",
			frame: { width: 560, height: 480 },
			rpc,
			// Created hidden so it is excluded from capture before it is ever on screen.
			hidden: true,
		});
		const poll = setInterval(() => this.deps.screenAccess.refresh(), SCREEN_ACCESS_POLL_MS);
		this.cleanup = [
			this.deps.screenAccess.subscribe((s) => rpc.send.screenAccessChanged(s)),
			() => clearInterval(poll),
		];
		win.on("close", () => {
			for (const c of this.cleanup) c();
			this.cleanup = [];
			this.window = null;
		});
		this.window = win;
		this.exclusion.protect(win, () => win.show());
	}

	close(): void {
		this.window?.close();
	}
}
