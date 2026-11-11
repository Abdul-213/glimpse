// Runs the round trip inside a Bun Worker, like Electrobun's app code.
import { runRoundTrip } from "../../src/shared/roundtrip";
import { ApiKeyStore, bunSecretsBackend } from "../../src/shared/secret-store";

declare const self: Worker;

self.onmessage = async (e: MessageEvent<{ service: string }>) => {
	const steps = await runRoundTrip(new ApiKeyStore(bunSecretsBackend, e.data.service), "spike-worker");
	const failed = steps.filter((s) => !s.ok);
	self.postMessage({ ok: failed.length === 0, failed });
};
