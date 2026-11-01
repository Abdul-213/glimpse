import { applyPlatform } from "@glimpse/ui";
import { render } from "solid-js/web";
import type { OnboardingRPC } from "../../shared/onboarding-rpc.ts";
import { connect } from "../rpc.ts";
import type { OnboardingClient, OnboardingPushHandlers } from "./client.ts";
import { OnboardingApp } from "./OnboardingApp.tsx";

// Push handlers are registered once the app mounts; earlier pushes are covered by the snapshot.
let handlers: OnboardingPushHandlers | null = null;

const rpc = connect<OnboardingRPC>(
	{
		requests: {},
		messages: {
			screenAccessChanged: (s) => handlers?.screenAccessChanged(s),
		},
	},
	30_000,
);

const client: OnboardingClient = {
	request: rpc.request,
	listen: (h) => {
		handlers = h;
	},
	close: () => rpc.send.closeOnboarding(),
};

const root = document.getElementById("root");
if (!root) throw new Error("onboarding: #root missing from index.html");

render(() => <OnboardingApp client={client} onReady={(platform) => applyPlatform(platform)} />, root);
