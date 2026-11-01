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
	private mode: OnboardingMode = "setup";
	private cleanup: (() => void)[] = [];

	constructor(
		private readonly deps: OnboardingDeps,
		private readonly exclusion: CaptureExclusion,
	) {}

	get isOpen(): boolean {
		return this.window !== null;
	}

	/**
	 * Open in `mode`. If the window is already open it is brought forward; setup already
	 * contains the screen-access step, so asking for `screen-access` doesn't replace it.
	 */
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
					goToStep: h.goToStep,
					setTarget: h.setTarget,
					pickLanguages: h.pickLanguages,
					downloadLanguages: h.downloadLanguages,
					cancelDownloads: h.cancelDownloads,
					loadPackCatalogue: h.loadPackCatalogue,
					setHotkey: h.setHotkey,
					skipSetup: h.skipSetup,
					finishSetup: h.finishSetup,
				},
				messages: {
					closeOnboarding: () => this.window?.close(),
				},
			},
		});
		const win = new BrowserWindow({
			title: mode === "setup" ? "Set up Glimpse" : "Glimpse",
			url: "views://onboarding/index.html",
			frame: { width: 560, height: 480 },
			rpc,
			// Created hidden so it is excluded from capture before it is ever on screen.
			hidden: true,
		});
		const poll = setInterval(() => this.deps.screenAccess.refresh(), SCREEN_ACCESS_POLL_MS);
		const { models, hotkeys } = this.deps.settingsDeps;
		this.cleanup = [
			this.deps.screenAccess.subscribe((s) => rpc.send.screenAccessChanged(s)),
			models.subscribe(() => {
				void h.downloads().then((d) => rpc.send.downloadsChanged(d));
			}),
			hotkeys.subscribe((s) => rpc.send.hotkeysChanged(s)),
			() => clearInterval(poll),
		];
		win.on("close", () => {
			for (const c of this.cleanup) c();
			this.cleanup = [];
			this.window = null;
		});
		this.window = win;
		// GLIM-98: follows "Hide Glimpse from screenshots and screen sharing", like Settings.
		this.exclusion.protect(win, () => win.show(), { role: "window" });
	}

	close(): void {
		this.window?.close();
	}
}
