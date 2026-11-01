// GLIM-76: the first-run setup flow as data (docs/design/flows/onboarding.html). Pure: the app
// passes what this OS needs (a screen-access step on macOS only), and settings remember where
// the user got to, so setup resumes there after a quit or a restart.

export const ONBOARDING_STEPS = ["welcome", "screen-access", "language", "downloads", "shortcuts", "done"] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingCapabilities {
	/** The OS gates capture behind a permission (macOS Screen Recording). */
	readonly screenAccessStep: boolean;
}

/** The steps for this OS, in order. */
export function onboardingSteps(caps: OnboardingCapabilities): OnboardingStep[] {
	return ONBOARDING_STEPS.filter((s) => s !== "screen-access" || caps.screenAccessStep);
}

/** The numbered steps in the strip (welcome and done aren't numbered). */
export function stripSteps(steps: readonly OnboardingStep[]): OnboardingStep[] {
	return steps.filter((s) => s !== "welcome" && s !== "done");
}

/** Where to resume: the saved step if this OS has it, else the first. */
export function resumeStep(steps: readonly OnboardingStep[], saved: string): OnboardingStep {
	return steps.find((s) => s === saved) ?? steps[0] ?? "welcome";
}

export function nextStep(steps: readonly OnboardingStep[], current: OnboardingStep): OnboardingStep {
	const i = steps.indexOf(current);
	return steps[Math.min(steps.length - 1, i + 1)] ?? current;
}

export function previousStep(steps: readonly OnboardingStep[], current: OnboardingStep): OnboardingStep {
	const i = steps.indexOf(current);
	return i > 0 ? (steps[i - 1] ?? current) : current;
}

export interface OnboardingProgress {
	readonly completed: boolean;
	/** "Skip setup": don't open it at launch; the tray offers "Finish setup…". */
	readonly dismissed: boolean;
}

/** Open setup at launch? Only while it is unfinished and wasn't skipped. */
export const opensAtLaunch = (p: OnboardingProgress): boolean => !p.completed && !p.dismissed;

/** Offer "Finish setup…" in the tray? Whenever it is unfinished. */
export const offersFinishSetup = (p: OnboardingProgress): boolean => !p.completed;
