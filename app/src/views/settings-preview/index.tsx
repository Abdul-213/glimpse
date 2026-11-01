// Dev-only Settings preview (GLIM-69): the real SettingsApp over a fake main process, so the
// window can be opened in a browser and screenshotted headlessly (scripts/settings-shots.ts).
//   ?os=macos|windows  &pane=general|shortcuts|providers|models|privacy|about
//   &scenario=conflict|idle  &dir=rtl   (appearance follows the browser's colour scheme)
import { applyPlatform } from "@glimpse/ui";
import { render } from "solid-js/web";
import { SECTIONS, type SectionId, SettingsApp } from "../settings/SettingsApp.tsx";
import { fakeSettingsClient } from "./fake-client.ts";

const q = new URLSearchParams(location.search);
const os = q.get("os") === "windows" ? "windows" : "macos";
const paneParam = q.get("pane");
const pane = SECTIONS.find((s) => s.id === paneParam)?.id ?? ("general" as SectionId);
applyPlatform(os);
document.documentElement.dir = q.get("dir") === "rtl" ? "rtl" : "ltr";

const root = document.getElementById("root");
if (!root) throw new Error("settings-preview: #root missing from index.html");
render(
	() => <SettingsApp client={fakeSettingsClient({ os, scenario: q.get("scenario") ?? "" })} initialSection={pane} />,
	root,
);
