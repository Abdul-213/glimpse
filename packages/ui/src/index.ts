// @glimpse/ui: shared Solid components for every webview. Styles come from
// "@glimpse/ui/theme.css" (Tailwind v4 + tokens generated from DESIGN.md + components.css).
// Components take props and emit callbacks: no RPC, no Electrobun (ARCHITECTURE.md §2).

export { Banner, type BannerProps, type BannerTone } from "./components/Banner.tsx";
export { BlockList, type BlockListProps } from "./components/BlockList.tsx";
export { Button, type ButtonProps, type ButtonVariant, buttonClass } from "./components/Button.tsx";
export {
	InlineMessage,
	type InlineMessageProps,
	SecretField,
	type SecretFieldProps,
	TextField,
	type TextFieldProps,
} from "./components/Field.tsx";
export { HotkeyRecorder, type HotkeyRecorderProps } from "./components/HotkeyRecorder.tsx";
export { Icon, type IconName, type IconProps } from "./components/Icon.tsx";
export { IconButton, type IconButtonProps } from "./components/IconButton.tsx";
export { Kbd, type KbdProps } from "./components/Kbd.tsx";
export { type PopupFacing, type PopupKind, PopupShell, type PopupShellProps } from "./components/PopupShell.tsx";
export { ProgressBar, type ProgressBarProps } from "./components/ProgressBar.tsx";
export {
	EgressBadge,
	type EgressBadgeProps,
	LocalIndicator,
	type LocalIndicatorProps,
} from "./components/ProviderIndicator.tsx";
export { SegmentedControl, type SegmentedControlProps, type SegmentOption } from "./components/SegmentedControl.tsx";
export {
	LanguagePicker,
	type LanguagePickerProps,
	Select,
	type SelectOption,
	type SelectProps,
} from "./components/Select.tsx";
export {
	SettingsControlRow,
	SettingsGroup,
	type SettingsGroupProps,
	SettingsRow,
	type SettingsRowIds,
	type SettingsRowProps,
} from "./components/SettingsGroup.tsx";
export { SkippedLine, type SkippedLineProps } from "./components/SkippedLine.tsx";
export {
	type LiveStatus,
	StateMessage,
	type StateMessageProps,
	StatusIndicator,
	type StatusIndicatorProps,
} from "./components/StatusIndicator.tsx";
export { Switch, type SwitchProps } from "./components/Switch.tsx";
export { type BlockKind, type BlockState, TextBlock, type TextBlockProps } from "./components/TextBlock.tsx";
export { TextButton } from "./components/TextButton.tsx";
export { Toolbar, type ToolbarProps } from "./components/Toolbar.tsx";
export { Tooltip, type TooltipProps } from "./components/Tooltip.tsx";
export * from "./format.ts";
export * from "./hotkey.ts";
export * from "./language-filter.ts";
export { applyPlatform, currentPlatform, type PlatformOptions, type UiMaterial, type UiPlatform } from "./platform.ts";
export { nextIndex, type Orientation } from "./roving.ts";
export { createFrameText, type FrameScheduler } from "./streaming.ts";
