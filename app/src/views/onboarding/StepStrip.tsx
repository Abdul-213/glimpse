import type { OnboardingStep } from "@glimpse/core";
import { For, type JSX } from "solid-js";

export const STEP_LABELS: Record<OnboardingStep, string> = {
	welcome: "Welcome",
	"screen-access": "Screen access",
	language: "Translate into",
	downloads: "Downloads",
	shortcuts: "Shortcuts",
	done: "Done",
};

/** The numbered steps (welcome and done aren't in the strip). */
export const stripOf = (steps: readonly OnboardingStep[]) => steps.filter((s) => s !== "welcome" && s !== "done");

export interface StepStripProps {
	steps: readonly OnboardingStep[];
	current: OnboardingStep;
	onSelect: (step: OnboardingStep) => void;
}

/** "1 Screen access · 2 Translate into · …": shows where you are; any step can be revisited. */
export function StepStrip(props: StepStripProps): JSX.Element {
	const strip = () => stripOf(props.steps);
	const currentIndex = () => props.steps.indexOf(props.current);
	return (
		<nav aria-label="Setup steps">
			<ol class="onboarding-strip">
				<For each={strip()}>
					{(step, i) => {
						const index = () => props.steps.indexOf(step);
						return (
							<li class="onboarding-strip-item">
								<button
									type="button"
									class="onboarding-strip-button"
									aria-current={step === props.current ? "step" : undefined}
									data-state={index() < currentIndex() ? "done" : undefined}
									onClick={() => props.onSelect(step)}
								>
									<span class="truncate">
										<span class="tabular-nums">{i() + 1}</span> {STEP_LABELS[step]}
									</span>
								</button>
							</li>
						);
					}}
				</For>
			</ol>
		</nav>
	);
}
