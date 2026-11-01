# GLIM-112: onnxruntime telemetry

Status: decided and implemented (2026-11-01).

## What ONNX Runtime does

The GLIM-103 smoke test found `~/.cache/Microsoft/DeveloperTools/.onnxruntime/{deviceid,
onnxruntime.db,-shm,-wal}` after one OCR call. What that is, from ORT's own docs
([docs/Privacy.md](https://github.com/microsoft/onnxruntime/blob/main/docs/Privacy.md)) and source
(`core/platform/device_id.h`, `core/platform/telemetry_environment.h`), and the strings in the
1.31.1 binaries onnxruntime-node ships:

- The official builds for Linux, macOS and Windows (not Windows ML) include Microsoft's
  cross-platform 1DS telemetry SDK, **on by default**. It sends "trace events" (session
  creation, execution providers used, errors, environment class) over HTTPS to
  `https://mobile.events.data.microsoft.com/OneCollector/1.0`. ORT says custom model metadata is
  not uploaded.
- It creates a **persistent device id** and an offline event store (SQLite `onnxruntime.db`):
  - Linux: `$XDG_CACHE_HOME` (or `~/.cache`)`/Microsoft/DeveloperTools/.onnxruntime/`
  - macOS: `~/Library/Application Support/Microsoft/DeveloperTools/.onnxruntime/`
  - Windows: registry `HKCU\SOFTWARE\Microsoft\DeveloperTools\.onnxruntime` (`deviceid`) and
    `%LOCALAPPDATA%\Microsoft\DeveloperTools\.onnxruntime\onnxruntime.db`
- It switches itself off when it sees a CI variable (`CI`, `GITHUB_ACTIONS`, ...), which is why
  CI never showed it.

So yes: on a user's machine, an unmodified Glimpse would have sent usage events to Microsoft with
a stable device id. PRODUCT.md promises nothing leaves the machine unless the user picks a cloud
provider; this broke that.

## Ways to turn it off

1. **`ORT_DISABLE_TELEMETRY=1`**, set before ORT initialises: "prevents the uploader, events, and
   persistent device identifier from being created for the process lifetime" on every 1DS build.
2. The C API's `DisableTelemetryEvents`: not exposed by onnxruntime-node, and ORT "may already
   have emitted a minimal initialization event before the API can be called".
3. Build ORT with `--no_telemetry`: means maintaining our own ORT builds for three platforms.
4. Point the storage at the app data dir: there's no setting for it, and it would still upload.

## Decision

Option 1. `services/ocr/ort-telemetry.ts` sets `ORT_DISABLE_TELEMETRY=1` and
`services/ocr/paddle-worker.ts` (`ocrSpawner`, which every path to the OCR Worker goes through:
the app, the harness, `ocr-smoke.ts`) calls it before any Worker exists. The Worker runs in the
same process, so it sees the variable.

It has to be the **real** process environment: in Bun 1.4.4, `process.env.X = "1"` only changes
JavaScript's copy, and libc `getenv` (what ORT calls) still returns NULL. Checked on Linux: with
only `process.env` set, the folder is still created. `native/process-env.ts` calls `setenv(3)`
(Linux, macOS) or `SetEnvironmentVariableW` (Windows, which ORT reads with
`GetEnvironmentVariableW`) through `bun:ffi`.

`bun test` sets it too (a preload in `bunfig.toml`), since provider tests load onnxruntime-node
directly. Dev scripts that load ORT outside the app (`packages/providers/scripts/*`) don't; set
`ORT_DISABLE_TELEMETRY=1` in your shell when you run them (CONTRIBUTING.md).

## Windows ETW

ORT builds made for Windows apps and Windows ML use ETW (TraceLogging) instead of 1DS, and the
env var doesn't cover that backend. The 1.31.1 `onnxruntime.dll` from npm is a 1DS build (it
contains the OneCollector endpoint, the `ORT_DISABLE_TELEMETRY` check and the device-id registry
key). If it also registers an ETW provider, ETW events are only recorded when a trace session is
listening, and what Windows itself collects follows the user's diagnostic data settings. We can't
switch that off from outside without our own ORT build; noted, not acted on.

## Tests

- `app/test/ocr-worker.test.ts`: one OCR call through the bundled Worker with the CI variables
  blanked and `XDG_CACHE_HOME` pointed at a temp folder: no `Microsoft/` folder is created. The
  shipped runtimes still contain the `ORT_DISABLE_TELEMETRY` name and the 1DS endpoint (so an ORT
  upgrade that changes either fails the test). `setProcessEnv` reaches libc `getenv`.
- `app/scripts/bundle-smoke.ts` (desktop.yml, after the Windows and macOS builds): the same OCR
  call with the CI variables blanked; fails if the OS's telemetry folder (or, on Windows, the
  registry key) appears.
