// Turn off ONNX Runtime's telemetry before the OCR Worker loads it (GLIM-112,
// docs/decisions/GLIM-112-onnxruntime-telemetry.md).
//
// The official onnxruntime builds that onnxruntime-node 1.31.1 ships (Linux, macOS, Windows)
// include Microsoft's 1DS telemetry SDK, on by default. When ORT starts it creates a persistent
// device id and an offline event store, and uploads events over HTTPS to
// mobile.events.data.microsoft.com:
//   Linux    $XDG_CACHE_HOME (or ~/.cache)/Microsoft/DeveloperTools/.onnxruntime/{deviceid,onnxruntime.db*}
//   macOS    ~/Library/Application Support/Microsoft/DeveloperTools/.onnxruntime/...
//   Windows  HKCU\SOFTWARE\Microsoft\DeveloperTools\.onnxruntime (deviceid) and
//            %LOCALAPPDATA%\Microsoft\DeveloperTools\.onnxruntime\onnxruntime.db
// ORT_DISABLE_TELEMETRY=1, set before ORT initialises, stops the uploader, the events and the
// device id for the life of the process. ORT reads it with getenv, so it must be in the real
// process environment (setProcessEnv), not only in Bun's process.env.
import { join } from "node:path";
import { setProcessEnv } from "../../native/process-env.ts";

export const ORT_TELEMETRY_ENV = "ORT_DISABLE_TELEMETRY";

/** The CI variables ONNX Runtime 1.31 checks to skip telemetry (core/platform/telemetry_environment.h). */
export const ORT_CI_VARIABLES: readonly string[] = [
	"CI",
	"TF_BUILD",
	"GITHUB_ACTIONS",
	"GITLAB_CI",
	"CIRCLECI",
	"TRAVIS",
	"JENKINS_URL",
	"CODEBUILD_BUILD_ID",
	"BUILDKITE",
	"TEAMCITY_VERSION",
	"APPVEYOR",
	"BITBUCKET_BUILD_NUMBER",
	"SYSTEM_TEAMFOUNDATIONCOLLECTIONURI",
];

/** Where ORT 1.31 keeps its device id and event store, per OS (for checks; see the header). */
export function ortTelemetryPaths(platform: string, env: Record<string, string | undefined>, home: string): string[] {
	const dir = ["Microsoft", "DeveloperTools", ".onnxruntime"];
	if (platform === "darwin") return [join(home, "Library", "Application Support", ...dir)];
	if (platform === "win32") return [join(env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"), ...dir)];
	return [join(env["XDG_CACHE_HOME"] || join(home, ".cache"), ...dir)];
}

/**
 * Set ORT_DISABLE_TELEMETRY=1 for this process. Call before anything loads onnxruntime; the OCR
 * spawner (`ocrSpawner`) does. Returns whether the native environment was updated.
 */
export function disableOrtTelemetry(set: (name: string, value: string) => boolean = setProcessEnv): boolean {
	return set(ORT_TELEMETRY_ENV, "1");
}
