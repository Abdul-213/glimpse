import { type JSX, splitProps } from "solid-js";

/** Small link-coloured action inside content ("Retry", "Translate these"). `label` type. */
export function TextButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
	const [local, rest] = splitProps(props, ["class", "type"]);
	return (
		<button type={local.type ?? "button"} class={["glim-text-btn", local.class ?? ""].join(" ").trim()} {...rest} />
	);
}
