// Dev-only onboarding preview (GLIM-45, GLIM-76): the real OnboardingApp over a fake main
// process, for a browser and for headless screenshots (scripts/onboarding-shots.ts).
//   ?os=macos|windows  &access=not-determined|denied|denied-opened|lost|lost-opened|granted
//   &dir=rtl   (appearance follows the browser's colour scheme)
import { applyPlatform } from "@glimpse/ui";
import { render } from "solid-js/web";
import { OnboardingApp } from "../onboarding/OnboardingApp.tsx";
import { fakeOnboardingClient } from "./fake-client.ts";

const q = new URLSearchParams(location.search);
const os = q.get("os") === "windows" ? "windows" : "macos";
applyPlatform(os);
document.documentElement.dir = q.get("dir") === "rtl" ? "rtl" : "ltr";

const root = document.getElementById("root");
if (!root) throw new Error("onboarding-preview: #root missing from index.html");
render(
	() => <OnboardingApp client={fakeOnboardingClient({ os, access: q.get("access") ?? "not-determined" })} />,
	root,
);
