import { type JSX, splitProps } from "solid-js";

export type ButtonVariant = "primary" | "secondary";

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
	/** DESIGN.md: at most one primary button per view. */
	variant?: ButtonVariant;
}

// Hover and press layer an overlay over the fill (DESIGN.md Buttons, fields and keys);
// an inset shadow does that without a pseudo-element.
const base =
	"inline-flex items-center justify-center gap-1.5 h-(--control-height) px-3 rounded-control " +
	"text-body font-normal select-none cursor-default whitespace-nowrap " +
	"transition-shadow duration-(--duration-fast) ease-standard " +
	"hover:shadow-[inset_0_0_0_100vmax_var(--color-overlay-hover)] " +
	"active:shadow-[inset_0_0_0_100vmax_var(--color-overlay-pressed)] " +
	"disabled:text-text-disabled disabled:shadow-none";

const variants: Record<ButtonVariant, string> = {
	// Disabled: the neutral control fill, so the disabled text never sits on the accent (gray-on-color).
	primary: "bg-accent text-on-accent disabled:bg-surface-control disabled:border disabled:border-border-control",
	secondary: "bg-surface-control text-text-primary border border-border-control",
};

export function buttonClass(variant: ButtonVariant = "secondary", extra?: string): string {
	return [base, variants[variant], extra].filter(Boolean).join(" ");
}

export function Button(props: ButtonProps): JSX.Element {
	const [local, rest] = splitProps(props, ["variant", "class", "type"]);
	return <button type={local.type ?? "button"} class={buttonClass(local.variant, local.class)} {...rest} />;
}
