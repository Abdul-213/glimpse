// Dev-only onboarding preview (GLIM-45, GLIM-76): the real OnboardingApp over a fake main
// process, for a browser and for headless screenshots (scripts/onboarding-shots.ts).
//   ?os=macos|windows  &mode=setup|screen-access
//   &step=welcome|screen-access|language|downloads|shortcuts|done
//   &access=not-determined|denied|denied-opened|lost|lost-opened|granted
//   &scenario=pick|downloading|offline|failed|conflict  &resumed=1  &dir=rtl
//   (appearance follows the browser's colour scheme)
import { applyPlatform } from "@glimpse/ui";
import { render } from "solid-js/web";
import { OnboardingApp } from "../onboarding/OnboardingApp.tsx";
import { fakeOnboardingClient } from "./fake-client.ts";

const q = new URLSearchParams(location.search);
const os = q.get("os") === "windows" ? "windows" : "macos";
applyPlatform(os);
document.documentElement.dir = q.get("dir") === "rtl" ? "rtl" : "ltr";

const client = fakeOnboardingClient({
	os,
	mode: q.get("mode") === "screen-access" ? "screen-access" : "setup",
	access: q.get("access") ?? "not-determined",
	step: q.get("step") ?? "welcome",
	scenario: q.get("scenario") ?? "",
	resumed: q.get("resumed") === "1",
});

const root = document.getElementById("root");
if (!root) throw new Error("onboarding-preview: #root missing from index.html");
render(() => <OnboardingApp client={client} />, root);
