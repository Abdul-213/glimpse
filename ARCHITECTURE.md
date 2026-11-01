# Glimpse architecture

Status: **binding** from GLIM-28 on. Change it with a PR that says why; don't work around it.
Inputs: [GLIM-26 stack decision](docs/decisions/GLIM-26-stack.md), [PRODUCT.md](PRODUCT.md),
[DESIGN.md](DESIGN.md), the other decisions in [docs/decisions/](docs/decisions/), and what the
Wave 0 spikes in [spikes/](spikes/) found.

Glimpse is one Electrobun app: a Bun main process, a few system webviews rendered with Solid,
and one small native helper library per OS, loaded with `bun:ffi`. Windows and macOS are the
product targets. Linux is a headless dev and CI target only: everything must typecheck, lint,
test and `electrobun build` there, but nothing user-facing is tuned for it.

## 1. Repository layout

```
.
├── app/                         @glimpse/app: the Electrobun app (the only package that imports electrobun)
│   ├── hutch.config.ts          Electrobun pin (2.0.6-beta.2) for Hutch
│   ├── electrobun.config.ts     app id, main entry, preBuild hook, copy rules
│   ├── src/
│   │   ├── bun/                 main process (runs in Electrobun's Bun worker)
│   │   │   ├── index.ts         composition root: build services, wire tray + windows. No logic.
│   │   │   ├── windows/         one controller per window type (settings.ts, later picker.ts, popup.ts, live.ts, onboarding.ts)
│   │   │   ├── services/        adapters that implement @glimpse/core ports with OS/Electrobun APIs
│   │   │   ├── native/          bun:ffi bindings: macos.ts, windows.ts (+ loader); nothing else calls dlopen
│   │   │   ├── tray.ts, displays.ts, platform.ts, ...
│   │   ├── shared/rpc.ts        typed RPC schemas, one per surface (split into shared/rpc/<surface>.ts when it grows)
│   │   └── views/               webviews, one folder per surface
│   │       ├── rpc.ts           connect<SurfaceRPC>(): the only place a view opens its RPC channel
│   │       └── <surface>/       index.html + index.tsx + index.css + components (settings now; picker, popup, live, onboarding later)
│   ├── scripts/                 build-views.ts (Bun.build + Solid + Tailwind), prebuild.ts (Electrobun hook), solid-plugin.ts, make-tray-icons.ts,
│   │                            harness.ts (headless CLI), native-smoke.ts, make-capture-fixtures.ts
│   ├── src/harness/             headless runner (GLIM-86): drives services without Electrobun or a webview
│   ├── assets/tray/             tray icons (copied to views://assets/)
│   ├── native/macos/            libglimpse.dylib source (Objective-C) + build.sh, see README
│   ├── native/windows/          glimpse.dll source (C++) + build.ps1 / build-zig.sh, see README
│   └── test/                    tests for the app's pure modules and the view build; fixtures/capture/ recordings
├── packages/
│   ├── core/                    @glimpse/core: pure TypeScript domain logic (see section 4)
│   ├── providers/               @glimpse/providers: provider implementations (Bun APIs, onnxruntime, WASM; no Electrobun)
│   │   ├── src/ocr/paddle/      PaddleOCR PP-OCRv5 on onnxruntime-node: engine (pure) + inference Worker + OcrProvider (GLIM-46)
│   │   ├── src/google/          shared Google Cloud plumbing: key from SecretStore, fetch + error mapping (GLIM-22)
│   │   ├── src/ocr/google-vision/  Google Cloud Vision OcrProvider (cloud, opt-in; GLIM-60)
│   │   └── src/translation/google-v2/  Google Cloud Translation v2 TranslationProvider (cloud, opt-in; GLIM-61)
│   └── ui/                      @glimpse/ui: shared Solid components + Tailwind theme from DESIGN.md
│       ├── scripts/             generate-tokens.ts: DESIGN.md frontmatter -> src/styles/tokens.css
│       └── src/                 components/, styles/theme.css, styles/tokens.css (generated), platform.ts
├── spikes/                      Wave 0 throwaway spikes. Reference only: copy from them, never import them.
├── docs/decisions/              ADRs. docs/design/: flows and token preview.
├── .github/workflows/ci.yml     Linux CI: typecheck, lint, test, harness, Linux build
├── .github/workflows/native.yml compile + load the native helpers on Windows/macOS runners
├── .github/workflows/desktop.yml Windows/macOS: typecheck, test, native helper, stable build, unsigned artifacts
├── package.json                 Bun workspace root (workspaces: app, packages/*) and the root scripts
├── tsconfig.base.json           shared strict compiler options; each package has its own tsconfig.json
├── biome.json                   lint + format, including the @glimpse/core import boundary
└── bunfig.toml                  `bun test` ignores spikes/, .hutch/, build output
```

Generated or downloaded, never committed: `node_modules/`, `app/.hutch/` (Electrobun devkit and
toolchains from `hutch electrobun sync`), `app/dist/` (built views), `app/build/`, `app/artifacts/`,
`app/native/*/build/`.

A new package is allowed when it has its own dependency rule (as `packages/providers` will, below).
Don't create packages for grouping alone; use folders.

## 2. Dependency rules

```
@glimpse/app  ──►  @glimpse/core
      │                 ▲
      └──►  @glimpse/ui ┘ (types only)
```

- **`@glimpse/core`** imports nothing from the outside world: no `electrobun`, no `bun:*`, no
  `node:*`, no `solid-js`, no DOM. Biome's `noRestrictedImports` enforces this for
  `packages/core/src`. Anything core needs from the OS (time, capture, files, secrets, network,
  inference) comes in through an interface ("port") that the app implements and tests fake.
- **`@glimpse/ui`** depends on `solid-js` and may import *types* from core. No Electrobun, no RPC:
  components take props and emit callbacks. It runs only inside webviews.
- **`@glimpse/app`** is the only package that imports `electrobun/*` or calls `dlopen`.
  `electrobun/main` loads native code on import, so modules that import it can't be unit-tested.
  Keep anything worth testing in modules that don't (see `platform.ts`, `trayIconFor`).
- Webview code (`app/src/views/**`) imports `electrobun/view`, `@glimpse/ui`, `solid-js` and
  types from `app/src/shared` and `@glimpse/core`. It never imports `app/src/bun/**`.
- The main process never imports from `app/src/views/**`.

## 3. Process model

```
 OS main thread                     Bun worker thread (app JS)                webview processes
 ───────────────                    ──────────────────────────                ─────────────────
 Electrobun launcher +              app/src/bun/index.ts                       WKWebView (macOS)
 native core: AppKit run loop /  ◄─ BrowserWindow, Tray, Screen,          ◄──► WebView2 (Windows)
 Win32 message loop, windows,       GlobalShortcut, RPC handlers,  RPC over   WebKitGTK (Linux dev)
 webview hosts                      services, pipeline orchestration  local socket
        ▲                                   │
        │ dispatch_sync / async             │ bun:ffi
        └──── libglimpse.dylib / glimpse.dll ◄┘          extra Bun Workers: OCR + translation inference
```

- **Electrobun runs app JS in a Bun `Worker`, not on the OS main thread.** The native core owns the
  main thread and runs the platform event loop (spikes/hotkeys/FINDINGS.md, spikes/overlay/FINDINGS.md).
- **macOS:** AppKit and Carbon must be called on the main thread. Every helper function that
  touches `NSWindow`, `NSView`, `NSApplication` or Carbon hops there with `dispatch_sync_f` /
  `dispatch_async_f` on the main queue inside `libglimpse.dylib`. TypeScript never calls AppKit
  through raw `bun:ffi` + `objc_msgSend`. Long waits (ScreenCaptureKit completions) block on a
  semaphore on a helper-owned queue, never on the main queue (spikes/capture/FINDINGS.md).
- **Windows:** thread-agnostic Win32 calls (`SetWindowDisplayAffinity`, `DwmSetWindowAttribute`,
  `SetWindowLongPtrW`, `GetMonitorInfoW`) go straight through `bun:ffi` from the Bun worker on
  `BrowserWindow.ptr` (the `HWND`). Anything that needs a message loop, a callback or COM
  apartments (DXGI/WGC capture) lives in `glimpse.dll`.
- **Callbacks from native to JS** use `JSCallback` with `threadsafe: true`. They arrive
  asynchronously on the Bun worker; don't expect a synchronous return value.
- **Keep the Bun worker responsive.** It serves every RPC call and native event. OCR (ONNX
  Runtime) and translation (Bergamot WASM) run in dedicated Bun `Worker`s owned by the pipeline,
  with plain-data messages in and out. If GLIM-17 shows inference can't run in-process, it moves
  to a sidecar process behind the same provider interface; nothing else changes (GLIM-26 "Revisit if").
  Electrobun bundles only `src/bun/index.ts`, and a `new Worker(new URL("./worker.ts",
  import.meta.url))` inside a dependency survives bundling verbatim, pointing at a file that
  isn't in the app. So each Worker entry is bundled on its own by `app/scripts/build-workers.ts`
  (preBuild hook) into `dist/workers/`, copied next to the main bundle (`<app>/bun/bergamot-worker.js`),
  and the app passes a spawner for it in the provider context
  (`services/translation/bergamot-worker.ts`: `GLIMPSE_BERGAMOT_WORKER`, then the bundled file,
  else the provider's own default when running from source). The PaddleOCR Worker works the same
  way (`<app>/bun/ocr-worker.js`, `services/ocr/paddle-worker.ts`, `GLIMPSE_OCR_WORKER`).
- **onnxruntime-node in the app (GLIM-103).** The npm package carries every platform's binaries
  (~260 MB); `scripts/onnxruntime.ts` (preBuild) stages only the target's binding and runtime
  library for the CPU provider into `dist/onnxruntime/`, copied to `<app>/native/onnxruntime/`
  (linux: `libonnxruntime.so.1`; darwin-arm64: `libonnxruntime.1.dylib`; win32: `onnxruntime.dll`;
  no DirectML/dxcompiler, which ORT only delay-loads for the DirectML/WebGPU providers). The
  bundled OCR Worker loads the binding from `../native/onnxruntime/` (`GLIMPSE_ORT_BINDING`
  overrides): `build-workers.ts` rewrites onnxruntime-node's package-relative `require`.
  darwin-x64 has no onnxruntime-node build (GLIM-89): the build succeeds without it (with a
  warning) and PaddleOCR's `init()` ends in `error` there. `scripts/ocr-smoke.ts <app dir>` runs one OCR call through a
  built app's Worker and prints which onnxruntime files were loaded.
- **Windows are pre-created where latency matters** (picker overlays, Snip popup) and hidden
  instead of destroyed; Settings and onboarding are created on demand. The app is a tray app:
  `exitOnLastWindowClosed: false`; only the tray's Quit ends it.
- `process.platform` decides OS-specific paths at the edge (in `app/src/bun/native/` and
  services). Core never branches on platform; it receives capabilities.

## 4. Where things go

| Thing | Location | Notes |
|---|---|---|
| Domain types (Rect, Region, Display, OcrBlock, BlockLanguage, Translation, LanguageCode) | `packages/core/src/` | Exists now. Extend, don't duplicate. |
| Provider interfaces `OcrProvider`, `TranslationProvider` | `packages/core/src/providers/` | GLIM-32, GLIM-33 |
| Provider registry and config schema | `packages/core/src/providers/` | GLIM-43 |
| Provider implementations (PaddleOCR/ONNX, Bergamot WASM, cloud OCR/translation) | `packages/providers/` (new package, created by the first implementation ticket) | May use Bun APIs, `fetch`, onnxruntime, WASM. **No Electrobun.** Testable on Linux with fixtures and a fake `fetch`. |
| Pipeline (capture → OCR → group → detect → filter → translate → result), Live loop, change detection | `packages/core/src/pipeline/` | Pure orchestration over ports: `CaptureSource`, `Clock`, providers. GLIM-48, 56, 58, 67 |
| Language detection rules, code mapping (BCP-47 ↔ FLORES/Bergamot) | `packages/core/src/language/` (grow `language.ts` into a folder) | GLIM-39, GLIM-49. Detector libraries (ELD, fastText WASM) are injected. |
| Translation cache, single-flight, OCR reuse | `packages/core/src/cache/` | GLIM-20 decision, GLIM-67 |
| Settings schema, defaults, migrations | `packages/core/src/settings/` | GLIM-53. Pure: `(unknown json) -> Settings`. |
| Settings persistence (file in the user data dir) | `app/src/bun/services/settings-store.ts` | Implements a core `SettingsStore` port. |
| Secrets (`Bun.secrets`) | `app/src/bun/services/secrets.ts` | GLIM-40. Core sees a `SecretStore` port (`packages/core/src/secrets/`: id pattern, no empty values, 2560-byte cap, error kinds, `maskSecret`); fake: `MemorySecretStore`. Service `dev.glimpse.app`, one item per `secretId`, Windows `persist: "local"`, no plaintext fallback. Headless Linux: `app/scripts/linux-headless-keyring.sh`. |
| `CaptureSource` port, capture geometry (`planCapture`), RGBA helpers, `FrameSequenceSource` | `packages/core/src/capture/` | GLIM-36. Fake: `ReplayCaptureSource` in `@glimpse/core/testing`. |
| Capture backends (DXGI/GDI, ScreenCaptureKit, file-based for Linux) | `app/src/bun/services/capture/` + native helpers | GLIM-36, GLIM-86. All implement core's `CaptureSource`; `createCaptureSource()` picks one (see "Capture" below). |
| Self-capture exclusion | `app/src/bun/windows/capture-exclusion.ts` | Every window controller shows its window through `CaptureExclusion.protect(win, show)`. |
| Region picker: state machine, snapping, HUD layout, geometry; OS ports (`WindowListSource`, `PixelSampler`, `FocusKeeper`) | `packages/core/src/picker/` | GLIM-29 spec, GLIM-44/54/55/91. Fakes in `@glimpse/core/testing`. Loupe pixels come from capture (`CapturePixelSampler`; macOS keeps an SCStream warm), never from the webview. |
| Picker OS ports (window list, loupe sampler, focus) | `app/src/bun/services/picker/` + `native/overlay.ts` | GLIM-91. `createPickerNatives()` picks per OS; the file backend gets no window list and no focus handling. |
| Hotkeys | `app/src/bun/services/hotkeys.ts` (service, pure) + `hotkeys-electrobun.ts` / `hotkeys-carbon.ts` (backends) + `hotkey-keys.ts` (accelerator / Carbon key-code mapping) | Electrobun `GlobalShortcut` on Windows, Carbon `RegisterEventHotKey` in libglimpse.dylib on macOS (GLIM-23, GLIM-44, spikes/hotkeys). A taken combo is reported as `conflict`, never rebound. Settings reaches it through the `HotkeyRegistrar` port (`services/hotkeys-port.ts`, `ServiceHotkeyRegistrar`). |
| Region picker window controller | `app/src/bun/windows/picker-controller.ts` (pure: overlays per display, session, ticks, `RegionSelected`) + `windows/picker.ts` (Electrobun overlays) + `app/src/views/picker/` | GLIM-44. `snip.start` / `live.start` call `picker.toggle(mode)`; Snip (GLIM-65) and Live (GLIM-59) subscribe with `picker.onRegionSelected` (return `"keep"` to keep the results layer). The harness drives it headless (`bun run harness pick`); `bun app/scripts/picker-preview.ts` renders the real view in a browser. |
| App commands (Start Snip, Start/Stop Live, Private, Clear cache, Settings, Quit...) | `app/src/bun/commands.ts` (`CommandBus`) | GLIM-41. Tray, hotkeys, popups and Settings dispatch; the owning feature registers the one handler. |
| Tray / menu bar | `app/src/bun/tray-menu.ts` (pure: state -> menu + icon, `TrayController`) + `tray.ts` (Electrobun) | GLIM-41. Rebuilt only when the rendered menu changes. Windows icon follows the taskbar theme (`services/taskbar-theme.ts`). |
| Window controllers (create, position, show/hide, materials, capture exclusion) | `app/src/bun/windows/<surface>.ts` | One class per window type, like `SettingsWindow`. |
| `bun:ffi` bindings | `app/src/bun/native/macos.ts`, `windows.ts`, `load.ts` | The only `dlopen` calls. Each exported function returns typed results, never raw pointers to callers outside `native/`. |
| Native helper sources | `app/native/macos/`, `app/native/windows/` | See section 6. |
| Logging and diagnostics | `packages/core/src/logging/` (`Logger` port, `Redactor`, line format, diagnostics bundle) + `app/src/bun/services/log.ts` (rotating file in `Utils.paths.userLogs`), `services/diagnostics.ts` | GLIM-35. Everything logged passes the `Redactor`: no keys, no screen text (wrap it in `sensitive()`), never pixels. |
| Shared UI components | `packages/ui/src/components/` | GLIM-42. Tokens only, no raw colours or off-scale sizes. |
| Surface UI | `app/src/views/<surface>/` | Thin: render state from main, send intents back. |

### Provider contracts (GLIM-32, GLIM-33)

`packages/core/src/providers/` defines what every OCR and translation engine looks like. The
rules every implementation follows (contract checks in `@glimpse/core/testing` enforce them):

- **Lifecycle.** `status` + `onStatusChange`, `init(signal)` (idempotent; ends in `ready`,
  `model-missing` with the missing `ModelResource`s, `needs-key`, or `error`), optional `warmup`,
  `dispose`. Providers never download models: they report what is missing, and the model manager
  fetches it with consent (GLIM-57, GLIM-85).
- **Cancellation.** Every call takes an `AbortSignal`. Aborting rejects with
  `ProviderError("cancelled")` promptly, even when the engine call itself can't be interrupted
  (`abortable()`). Cancelled work is never cached.
- **OCR** is one call per image: `recognise({ image, languages?, regions? }, { signal,
  onProgress })` → blocks in region-local device pixels. Progressive engines emit `detected`
  boxes, then each `block` (Snip shows boxes before text). Whole-request failures throw a typed
  `ProviderError`. `languageSupport(lang)` reports per-language readiness, since PP-OCRv5 needs
  one recognition model per script family (spikes/inference/FINDINGS.md).
- **Warmup.** GLIM-17 measured a slow first call per Bergamot pack (0.3–0.8 s) and per ORT
  session; implementations do a dummy run in `warmup()`, which the app calls after `init()`.
- **Translation** is a batch of segments, each with its own source language (GLIM-21), and one
  target: `translate(request)` returns an `AsyncIterable` of `partial` (cumulative text, streaming
  engines only) and exactly one `done` or `error` per segment. Per-segment and request-level
  failures (pack missing, bad key, offline) are `error` events; the stream only rejects on
  cancellation. `pairSupport(from, to)` says `ready` / `missing` / `unsupported` and gives the
  route as hops (`ja→en→de` for the Bergamot pivot), each with its own fingerprint so the cache
  can key per hop (GLIM-20).
- **Capabilities** are static data: `kind` (local/cloud), `needsNetwork`, `secretId` (keychain
  entry, shared by Vision and Translation v2), languages, `pivot`, `streaming`,
  `contextSensitive`, request limits (callers split with `chunkSegments`), `progressive`,
  `regions`, `maxImagePixels`.
- **Provenance on every result** (`Provenance`: id, name, kind, model revision, options hash).
  The cloud indicator reads it; the cache keys on it; only the cache sets `remembered`.
- **Errors** share one vocabulary (`ProviderErrorCode`), plain-data `ProviderErrorInfo` for RPC.
- **Cloud providers (GLIM-22)** live in `packages/providers/src/{ocr,translation}/google-*`
  over `src/google/common.ts`: one Google Cloud key (`secretId: "google-cloud"`) read from the
  `SecretStore` port per request, plain `fetch` from Bun with the key in `x-goog-api-key`
  (never in a URL), and Google's errors (`API_KEY_INVALID`, `SERVICE_DISABLED`,
  `BILLING_DISABLED`, quota, rate limit) mapped to core codes plus a `GoogleProblem` with fix-it
  copy. `init()` only checks a key is saved (`ready` / `needs-key`), no network. Vision sends
  the region as a metadata-free PNG; its per-block `detectedLanguages` become
  `OcrBlock.languageHints`, which GLIM-21 detection uses as a prior (never rules 2–4). Translation
  v2 always sends `source` (from GLIM-21), `format: "text"`, `model: "nmt"`, one request per
  source language (128 `q` max); its language list starts from the catalogue's `google` column
  and is refreshed from `GET /v2/languages` in `warmup()`. Request-level failures become
  per-segment `error` events and stop the remaining batches. Tests use
  a `FakeFetch` (`@glimpse/providers/testing`) with fixtures in `test/fixtures/google/`; the
  real-API test runs only with `GLIMPSE_GOOGLE_KEY`.
- **Language codes** at the interface are BCP-47 `LanguageCode`s. A provider maps to its own
  scheme at its edge through a `LanguageCodeMap` (`providers/language-map.ts`); GLIM-39 supplies
  the real FLORES/Bergamot/Google tables.

### Provider registry and config (GLIM-43)

- Each implementation exports a factory (`OcrProviderFactory` / `TranslationProviderFactory`):
  static `info` + `capabilities` (Settings lists providers without loading models), an options
  schema whose fields all have defaults, a `defaultRank` (null = opt-in), and `create(options,
  ctx)`. The app builds one `ProviderRegistry<Ctx>` in its composition root and registers them;
  `Ctx` carries the ports providers need (fetch, `SecretStore`, model directory, worker spawner).
- Config (`ProvidersConfig`, stored in settings) selects one OCR provider and an ordered
  **translation chain**; `routeTranslation(chain, from, to)` picks the first provider that is
  ready for the pair, else the first that only lacks a download (the UI offers it), else
  unsupported. Default chain: `bergamot`, `small100`; Enhanced puts `hymt2` first. Well-known ids
  are in `PROVIDER_IDS`.
- Privacy rules live in the registry, not the UI: cloud providers can't have a `defaultRank`, and
  a cloud provider after a local one in the chain is removed on load (it would be a silent cloud
  fallback when a pack is missing).
- Options are kept per provider id, also for providers that aren't installed, so a build without
  one doesn't erase the user's choice; `resolve()` skips unknown ids at runtime and says why.
- Validation uses core's own `schema/` kit (`object`, `array`, `withDefault`, ...), not a
  library: config must be **repaired field by field** (bad value → default + an `Issue`), never
  rejected whole. See the header of `packages/core/src/schema/index.ts`.

### Pipeline and translation cache (GLIM-102, GLIM-20)

- **`TranslationPipeline`** (`packages/core/src/pipeline/`): `snip(capture, rect, opts)`,
  `run(image, opts)` (one frame) and `translate(blocks, opts)` (Retry with `bypassCache`,
  "Translate these" with `includeSkipped`, blocks waiting on a pack once it lands). Stages:
  OCR (boxes first) → `BlockGrouper` → `BlockLanguageDetector` → `classifyBlock` (translate / skip /
  neutral / target, subset filter) → `planTranslation` (provider routing, pack rows, unsupported)
  → `executeTranslation` (normalise, split sentences, cache per sentence and hop, batches).
  Grouping (GLIM-56) and detection (GLIM-49) come in through those two ports
  (`pipeline/stages.ts`, GLIM-109): `lineGrouper` runs `groupLines` on engine lines and passes
  blocks an engine already grouped (they carry `lines`) through; `glim21Detector` runs the
  GLIM-21 rules over the detector libraries it is given (ELD, loaded lazily, picked per subset
  with `planDetector`). Snip decides each capture alone; Live keeps one
  `LanguageDetectionSession` per session (text cache, rule 5a, hysteresis), keyed by the
  session's memo map, and `LivePipelineSession` re-ids blocks with a `BlockIdTracker` so the
  hysteresis and the popup see stable ids. The app builds both in
  `services/translation/pipeline-stages.ts` (composition root and harness). Without them the
  pipeline falls back to `identityGrouper` and the script-table `scriptLanguageDetector` (tests).
- **Events** (`pipeline/events.ts`) follow snip-popup.md §4/§8: `started` → `detected` →
  `recognised` (authoritative block list) → `packs` → `translation` per block (non-final ones
  show translated sentences + remaining source) → `progress` → exactly one `done` with the
  `PipelineResult` (error kinds E1–E7, provenance, `cloud`, `private`). Cancellation rejects with
  `cancelled` and emits nothing more. Every event carries `runId`.
- **Batching:** direct routes send every block's sentences as one batch (chunked to provider
  limits); pivot routes go block by block (hop 1 then hop 2), so the first block shows first.
- **App side:** `app/src/bun/services/providers.ts` registers every factory and builds the
  provider context (`AppProviderContext`); `services/translation/translation-service.ts`
  (`TranslationService`) creates the configured providers after the model scan, runs `init()` +
  `warmup()` in the background, owns the pipeline, the caches and Private, and backs the
  `cache.clear` and `private.toggle` commands. Settings changes reach it through
  `AppSettings.subscribe` → `applySettings(next, previous)` (GLIM-108): a changed provider
  selection, order or options rebuilds only the providers whose (id, options) changed and
  disposes dropped ones; new languages update open Live sessions (`setSources` drops the
  detection memo, `setTarget`) and re-warm the chain; the idle-wipe minutes go to the caches.
  Snip reads target and sources per call. Live params (fps, diff threshold, stability) belong
  to the Live loop (GLIM-58/59), which reads them from `AppSettings`. Snip and Live call `translation.snip()` /
  `translation.openLive()`.
- **Live:** `LivePipelineSession` feeds settled frames through `run`, latest frame wins (the
  older run is dropped, but only cancelled after the newer one has joined the sentences they
  share), and keeps the session detection memo and session cache.
- **Cache** (`packages/core/src/cache/`): `normaliseSegment` (the GLIM-20 normaliser, the text
  that is hashed is the text that is sent), `keyHash`/`keyIdentity` (versions, text, codes as
  sent, hop fingerprint, context hash), `TranslationCache` (byte- and entry-bounded LRU, 16 MB /
  20,000; `lookup` = hit / join in-flight / claim; only `complete` writes; a waiter that cancels
  detaches; `clear` also blocks late writes). `TranslationCaches` owns the app-wide cache, the
  Private scopes (non-storing Snip cache, isolated per Live session) and the wipes: user,
  idle (an open Live session counts as activity), sleep (detected from a wall-clock jump
  between `tick()`s), lock (reported by the app).

### Settings (GLIM-53)

- **Schema** (`packages/core/src/settings/schema.ts`): `Settings` = language (target, source
  subset; empty = all), hotkeys (canonical `Alt+Shift+S` strings, GLIM-23 defaults per OS),
  providers (`ProvidersConfig`), appearance (theme, motion), live (fps, diff threshold, stability
  ms), privacy (Private by default, idle cache wipe, wipe on lock), system (launch at login),
  models (storage folder, null = default; GLIM-96),
  onboarding (completed), diagnostics (log level). Every field has a default; machine-dependent defaults come in through
  `SettingsEnv` (built by `app/src/bun/services/settings-env.ts`).
- **File**: `<Utils.paths.userData>/settings.json`, `{ "version": N, ...settings }`, no secrets
  (keys live in the keychain). `FileSettingsStore` implements the core `SettingsStore` port:
  temp file + fsync + rename (retried on Windows), directory fsync on POSIX, backups as
  `settings.json.<reason>-<stamp>.bak` (newest 3 per reason).
- **Policy** (`loadSettings`, pure): no file → defaults; unreadable JSON or a failed migration →
  back up, write defaults, warn; older version → back up, run `SETTINGS_MIGRATIONS` in order,
  rewrite; newer version → back up, load what we understand; bad field → default for that field
  and a warning, file untouched until the next save.
- **Changing settings**: views send a patch; main applies it with `applySettingsPatch` (deep
  merge, re-validate, invalid fields keep their current value) and saves with `saveSettings`.
  The one live copy is `AppSettings` (`app/src/bun/services/app-settings.ts`): `update(patch)`
  applies, notifies subscribers (log level, tray, open Settings windows) and saves in order,
  so changes apply without a restart. Adding a field with a default needs no migration;
  renaming or reshaping one does (bump `SETTINGS_VERSION`, add a `Migration`, add a fixture test).
- **Settings window (GLIM-69)**: `app/src/shared/settings-rpc.ts` is the contract. The view
  may patch only `language`, `appearance`, `live`, `privacy`, `diagnostics`; hotkeys go
  through `setHotkey` (Glimpse conflict check, then the `HotkeyRegistrar` port in
  `services/hotkeys-port.ts`; an OS refusal keeps the old binding), launch at login through
  `LoginItem` (`services/login-item.ts`, GLIM-77 decision), the models folder through
  `ModelsSettings` (`services/models/models-settings.ts`, moves with `ModelManager.relocate`).
  Handlers live in `windows/settings-handlers.ts` (tested on Linux). The view is a mirror:
  `views/settings/state.ts` holds what main sent. `views/settings-preview` (dev-only) renders
  it over a fake client; `bun app/scripts/settings-shots.ts --shots docs/design/screens/settings`
  regenerates the committed screenshots.
- **Source-language subset (GLIM-68)**: `packages/core/src/language/source-subset.ts`: the
  languages offered (detectable or locally translatable) and script grouping; the pipeline's
  `classifyBlock` applies the subset (empty = all). Settings stores catalogue tags only (`sourceLanguageSchema` rejects others). UI:
  `LanguageMultiSelect` in `@glimpse/ui` (search, script groups, chips).

### Capture (GLIM-36)

- **Port:** `CaptureSource` (`packages/core/src/capture/port.ts`): `capture(rect)` for Snip,
  `openSession(rect, {fps})` for Live (a persistent stream; `next()` returns the latest frame and
  its `sequence`, which stays put while the backend sees no new screen content), `displays()`,
  `setExcludedWindows(ids)`. Rects are **global logical**; frames are RGBA8 at `scale` output px
  per logical unit (default: the highest `scaleFactor` the rect touches); `toOcrImage(frame)`
  hands one to an `OcrProvider`. Failures are `CaptureError`s with a code (`permission-denied`,
  `temporarily-unavailable`, `no-display`, ...).
- **Geometry:** `planCapture()` splits a rect per display and maps each piece into the backend's
  native space: macOS points (ScreenCaptureKit scales), Windows physical px (glimpse.dll reports
  monitor rects keyed by HMONITOR = Electrobun's `Display.id`; mixed-DPI pieces are resampled in
  the DLL). Pieces tile the output exactly. Parts on no display are opaque black.
- **Windows:** GDI for Snip; DXGI Desktop Duplication for Live, falling back to GDI per monitor
  (lasting DXGI failure) or per frame (temporary, e.g. a mode switch). WGC isn't used: it draws a
  border round the monitor.
- **macOS:** `SCScreenshotManager` for Snip, one `SCStream` per display piece for Live. Calls
  block the Bun worker on a semaphore with a timeout; moving them off the worker is a follow-up if
  it shows in latency.
- **Exclusion:** window controllers create windows `hidden: true` and show them through
  `CaptureExclusion.protect(win, show)`. Windows: `WDA_EXCLUDEFROMCAPTURE` before the first show;
  this hides Glimpse from *every* capture, screenshots and screen sharing included, and needs
  build 19041+. macOS: `sharingType = none`, and the SCK filter excludes Glimpse's app (or its
  window ids, kept current through `setExcludedWindows`), which also works on macOS 15+ where SCK
  ignores `sharingType`.
- **Choice:** `createCaptureSource()` (`app/src/bun/services/capture/index.ts`): native on
  Windows/macOS, the file-based backend (GLIM-86, section 7) on Linux. `GLIMPSE_CAPTURE=native|file`
  and `GLIMPSE_CAPTURE_FRAMES=<folder|png>` override it on any OS. It never throws; without a
  usable backend it returns a source whose calls fail with `unavailable`, and the reason goes to
  the startup log.

## 5. Views and RPC

**Build.** `app/scripts/build-views.ts` builds every `app/src/views/<name>/index.html` with
`Bun.build` (HTML entrypoint, `target: "browser"`, ESM). Three plugins:
`solid-plugin.ts` compiles `.tsx` with `babel-preset-solid` (Bun's JSX transform is React-style),
`bun-plugin-tailwind` runs Tailwind v4, and `electrobunDevkitPlugin` resolves `electrobun/*` to the
devkit in `app/.hutch/devkit` (the same mapping Electrobun's Vite helper uses). Output goes to
`app/dist/views/<name>/{index.html,index.js,index.css}` with stable, hashless names.
`electrobun.config.ts` runs it as the `preBuild` hook and copies `dist/views` to `views/`, so a
window loads `views://<name>/index.html`. Electrobun's own `build.views` is not used: Hutch
bundles those with esbuild and has no plugin hook.

**Adding a surface:** create `app/src/views/<name>/` with `index.html` (copy settings'),
`index.tsx` and `index.css` (`@import "@glimpse/ui/theme.css"; @source "./";`), add
`<Name>RPC` to `app/src/shared/rpc.ts`, and a controller in `app/src/bun/windows/<name>.ts`. Nothing
else to register: the build picks up every folder with an `index.html`.

**RPC contract.** One schema type per surface in `app/src/shared/rpc.ts`, imported with `import
type` on both sides:

- `bun.requests`: view → main, awaited (`rpc.request.getAppInfo()`), for reads and commands that
  return a result.
- `bun.messages`: view → main, fire-and-forget (`rpc.send.closeSettings()`), for user intents.
- `webview.requests` / `webview.messages`: main → view. Prefer messages that push state.

Rules:

1. **The main process owns state; views render it.** A view never holds the source of truth for
   settings, results or session state. It sends intents and renders what main pushes. That keeps
   behaviour in testable TypeScript and lets the Linux harness drive the app without a webview.
2. **Payloads are plain JSON data** built from `@glimpse/core` types. No classes, functions or
   `Date`s (use epoch ms). No image bytes for routine updates; send boxes and text.
3. **Name requests as verbs** (`getAppInfo`, `setHotkey`), messages as events or intents
   (`resultUpdated`, `closeSettings`). Every request handler validates its params; views are less
   trusted than main.
4. Views open the channel once, through `connect<SurfaceRPC>()` in `app/src/views/rpc.ts`. Window
   controllers create the matching `BrowserView.defineRPC<SurfaceRPC>()` in
   `app/src/bun/windows/<surface>.ts`.
5. Theme and platform go in through the DOM, not ad hoc props: the view calls
   `applyPlatform(info.platform)` (sets `data-os` on `<html>`), and the shell injects
   `--os-accent` / `--os-accent-dark` when accent support lands.

**Styling.** Tailwind v4 with the theme generated from DESIGN.md: `bun run tokens` turns the
DESIGN.md frontmatter (+ motion values from `.impeccable/design.json`) into
`packages/ui/src/styles/tokens.css`, and a test fails if it is stale. Tailwind's default palette,
fonts, text sizes and radii are switched off, so only DESIGN.md tokens exist (`bg-surface-popup`,
`text-text-secondary`, `rounded-control`, `p-3`). Prose-only rules (Windows control height and
body size, focus ring) live in `packages/ui/src/styles/theme.css`. Use logical utilities
(`ps-`, `me-`, `border-e`) everywhere.

## 6. Native helpers

- One library per OS: **macOS `libglimpse.dylib`** (Objective-C or Swift; window level and
  collection behaviour, `NSVisualEffectView`, `sharingType`, ScreenCaptureKit, Carbon hotkeys)
  and **Windows `glimpse.dll`** (C++; DXGI/WGC capture, GDI fallback). Plain Win32 calls skip the
  DLL (section 3). Linux has no helper; it uses fakes and the file-based capture backend.
- Sources and build scripts in `app/native/<os>/`, output to `app/native/<os>/build/` (gitignored).
  `electrobun.config.ts` copies the built library to `native/<file>` inside the app, only when
  building on that OS. At runtime, `app/src/bun/native/load.ts` resolves it as
  `resolve(import.meta.dir, "../native", file)` (the main bundle sits at `app/bun/index.js`), with
  a dev fallback to `app/native/<os>/build/`.
- C ABI only: symbols prefixed `glim_`, integer status returns (0 = ok, else `OSStatus` /
  `HRESULT` / Win32 error), out-params for data, caller-owned buffers or an explicit
  `glim_free`. The TypeScript binding maps codes to typed errors.
- `load.ts` checks `glim_abi_version()` against `GLIM_ABI_VERSION` after `dlopen`; bump both
  together when an export changes. `GLIMPSE_NATIVE_LIB=<path>` overrides the lookup. Glimpse's
  own status codes are -1..-99 (`app/native/*/glimpse.h` = `app/src/bun/native/status.ts`);
  other non-zero values are the OS's (`HRESULT`, NSError code) and map to typed `CaptureError`s.
- If the helper is missing or a symbol fails to load, the binding reports "unavailable" and the
  feature degrades (and says so in diagnostics). The app must still start. `electrobun.config.ts`
  copies the helper only if it was built, and `scripts/prebuild.ts` warns when it wasn't.
- Helpers can't be built on the Linux dev box (the Windows one can be cross-compiled with zig:
  `app/native/windows/build-zig.sh`). `.github/workflows/native.yml` compiles both, on
  windows-latest (MSVC) and macos-latest, and loads them through the real bindings
  (`app/scripts/native-smoke.ts`). It runs on pushes to `develop` that touch native code or its
  bindings, and on demand. Any PR that changes them states plainly that it is unverified on
  hardware until those runs and a manual check (GLIM-87) pass.

## 7. Testing strategy

1. **Pure core, tested hard.** Everything in `@glimpse/core` is unit-tested with `bun test` on
   Linux: geometry, language rules, pipeline orchestration, cache, settings migrations. Inputs are
   plain data and fakes; no timers or randomness without an injected `Clock`/seed.
2. **Fakes for every port.** Each port in core ships a fake next to it
   (`packages/core/src/testing/`, exported as `@glimpse/core/testing`): `FakeOcrProvider`
   (scripted blocks), `FakeTranslationProvider` (deterministic `text [ja>en]` output, pivots,
   missing packs, scripted failures, a `manualGate` to hold segments), `ReplayCaptureSource`
   (in-memory frames over a fake display layout, stepped per grab or timed by a `ManualClock`),
   and later an in-memory `SecretStore`. Tests in
   other packages use these instead of hand-rolled mocks. Provider implementations also run the
   contract checks: `for (const c of translationProviderContract(make, fixture)) test(c.name, c.run)`
   (same for `ocrProviderContract`).
3. **App modules:** test what doesn't import `electrobun/main` (mappers, controllers' pure parts,
   config). `app/test/views.test.ts` builds the real webviews and checks the Solid, Tailwind and
   devkit wiring. Never import `electrobun/main` in a test: it loads the native core.
4. **Providers** (`packages/providers`) are tested on Linux with small fixture images/models and a
   fake `fetch` for cloud ones. Accuracy and latency benchmarks are separate (GLIM-64).
5. **Linux headless harness (GLIM-86):** runs the real main-process services and pipeline with the
   file-based capture backend and a fake display list, so Snip and Live flows can be exercised end
   to end in CI without a desktop.
   - **File backend** (`app/src/bun/services/capture/file.ts`): a frame folder holds PNGs, each
     one the whole virtual desktop, plus an optional `frames.json` with the display layout
     (logical bounds, scale, where each display sits in the PNG), frame order and `holdMs`,
     `advance: per-grab | timed` and `end: hold | loop`. Identical consecutive frames keep the
     same `sequence`, like an idle DXGI/SCStream. The sample recording is
     `app/test/fixtures/capture/sample` (two displays, 2x + 1x); regenerate it with
     `bun run --filter @glimpse/app fixtures:capture`.
   - **Runner** (`app/src/harness/run.ts`): `runSnip` / `runLive` with pluggable **stages**.
     `pipelineStage({ ocr, detect?, translation, to, sources?, cache? })` runs the core
     `TranslationPipeline` on each frame (tests drive it with the core fakes); change detection
     (GLIM-58) plugs in as another stage. CLI: `bun run harness <displays|snip|live> [--frames dir] [--rect
     x,y,w,h] [--fps n] [--count n] [--realtime] [--out dir] [--json]`, plus `--pipeline
     [--ocr scripted|paddle] [--ocr-text "a|b"] [--translator fake|bergamot] [--to de] [--sources ja,de]
     [--private]` (real grouping and ELD detection; `scripted` OCR reads `--ocr-text`, `paddle` is
     real PaddleOCR over the dev model cache; `bergamot` uses the real WASM provider over packs
     already installed in `~/.cache/glimpse/test-installs`, offline). A rendered Japanese/German
     frame for real-OCR runs is `app/test/fixtures/capture/mixed-ja-de/mixed-ja-de.png`. It exits 1 on a capture
     error. `--native` runs the same flows against the real backend on a Windows PC or Mac,
     without Electrobun.
6. **Real hardware:** what only Windows/macOS can show (materials, overlays above fullscreen apps,
   capture permission, hotkey conflicts) is covered by the ticket's manual test notes, the
   Windows/macOS CI builds (GLIM-34) and GLIM-87. PRs say what is unverified.

CI (`.github/workflows/ci.yml`) runs on ubuntu-latest for PRs to and pushes on `develop`:
install, `hutch electrobun sync`, typecheck, `biome ci`, `bun test`, a harness Snip + Live run
over the sample recording, and a Linux `electrobun build`. Windows and macOS runners are only used by their dedicated, path-filtered workflows
(`native.yml`; `desktop.yml`, which also uploads the unsigned builds, see CONTRIBUTING.md).

## 8. Conventions

- TypeScript strict everywhere (`tsconfig.base.json`: `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, ...). The app relaxes only
  `exactOptionalPropertyTypes`, because the Electrobun SDK is type-checked from source and fails it.
- No `any` without a comment saying why. No non-null assertions (`!`); narrow instead.
- Imports use explicit `.ts`/`.tsx` extensions and `import type` for types.
- Files: `kebab-case.ts` for modules, `PascalCase.tsx` for components. One window controller or
  service per file.
- Coordinates always say their space (logical vs physical, global vs display/region-local); see
  `packages/core/src/geometry.ts`.
- Language identifiers are canonical BCP-47 `LanguageCode`s; map to other schemes only at a
  provider's edge.
- UI copy follows PRODUCT.md and DESIGN.md (sentence case, no uppercase labels, the OS's voice).
