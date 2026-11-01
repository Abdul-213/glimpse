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
│   ├── scripts/                 build-views.ts (Bun.build + Solid + Tailwind), prebuild.ts (Electrobun hook), solid-plugin.ts, make-tray-icons.ts
│   ├── assets/tray/             tray icons (copied to views://assets/)
│   ├── native/macos/            libglimpse.dylib source + build.sh (empty, see README)
│   ├── native/windows/          glimpse.dll source + build script (empty, see README)
│   └── test/                    tests for the app's pure modules and the view build
├── packages/
│   ├── core/                    @glimpse/core: pure TypeScript domain logic (see section 4)
│   └── ui/                      @glimpse/ui: shared Solid components + Tailwind theme from DESIGN.md
│       ├── scripts/             generate-tokens.ts: DESIGN.md frontmatter -> src/styles/tokens.css
│       └── src/                 components/, styles/theme.css, styles/tokens.css (generated), platform.ts
├── spikes/                      Wave 0 throwaway spikes. Reference only: copy from them, never import them.
├── docs/decisions/              ADRs. docs/design/: flows and token preview.
├── .github/workflows/ci.yml     Linux CI: typecheck, lint, test, Linux build
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
| Secrets (`Bun.secrets`) | `app/src/bun/services/secrets.ts` | GLIM-40. Core sees a `SecretStore` port. |
| Capture backends (DXGI/GDI, ScreenCaptureKit, file-based for Linux) | `app/src/bun/services/capture/` + native helpers | GLIM-36, GLIM-86. All implement core's `CaptureSource`. |
| Hotkeys | `app/src/bun/services/hotkeys.ts` | Electrobun `GlobalShortcut` on Windows, Carbon via the dylib on macOS (GLIM-23, spikes/hotkeys). |
| Window controllers (create, position, show/hide, materials, capture exclusion) | `app/src/bun/windows/<surface>.ts` | One class per window type, like `SettingsWindow`. |
| `bun:ffi` bindings | `app/src/bun/native/macos.ts`, `windows.ts`, `load.ts` | The only `dlopen` calls. Each exported function returns typed results, never raw pointers to callers outside `native/`. |
| Native helper sources | `app/native/macos/`, `app/native/windows/` | See section 6. |
| Logging and diagnostics | `app/src/bun/services/log.ts` (+ a core `Logger` port) | GLIM-35 |
| Shared UI components | `packages/ui/src/components/` | GLIM-42. Tokens only, no raw colours or off-scale sizes. |
| Surface UI | `app/src/views/<surface>/` | Thin: render state from main, send intents back. |

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
- If the helper is missing or a symbol fails to load, the binding reports "unavailable" and the
  feature degrades (and says so in diagnostics). The app must still start.
- Helpers can't be built on the Linux dev box. They are compiled in CI on macOS and Windows
  runners (GLIM-34). Any PR that changes them states plainly that it is unverified on hardware
  until those runs and a manual check (GLIM-87) pass.

## 7. Testing strategy

1. **Pure core, tested hard.** Everything in `@glimpse/core` is unit-tested with `bun test` on
   Linux: geometry, language rules, pipeline orchestration, cache, settings migrations. Inputs are
   plain data and fakes; no timers or randomness without an injected `Clock`/seed.
2. **Fakes for every port.** Each port in core ships a fake next to it
   (`packages/core/src/testing/`, exported as `@glimpse/core/testing` once the first one exists):
   a `CaptureSource` that replays PNG frames, a scripted `OcrProvider`, a deterministic
   `TranslationProvider`, an in-memory `SecretStore`, a manual `Clock`. Tests in other packages use
   these instead of hand-rolled mocks.
3. **App modules:** test what doesn't import `electrobun/main` (mappers, controllers' pure parts,
   config). `app/test/views.test.ts` builds the real webviews and checks the Solid, Tailwind and
   devkit wiring. Never import `electrobun/main` in a test: it loads the native core.
4. **Providers** (`packages/providers`) are tested on Linux with small fixture images/models and a
   fake `fetch` for cloud ones. Accuracy and latency benchmarks are separate (GLIM-64).
5. **Linux headless harness (GLIM-86):** runs the real main-process services and pipeline with the
   file-based capture backend and a fake display list, so Snip and Live flows can be exercised end
   to end in CI without a desktop.
6. **Real hardware:** what only Windows/macOS can show (materials, overlays above fullscreen apps,
   capture permission, hotkey conflicts) is covered by the ticket's manual test notes, the
   Windows/macOS CI builds (GLIM-34) and GLIM-87. PRs say what is unverified.

CI (`.github/workflows/ci.yml`) runs on ubuntu-latest for PRs to and pushes on `develop`:
install, `hutch electrobun sync`, typecheck, `biome ci`, `bun test`, and a Linux `electrobun
build`. Windows and macOS runners are only used by their dedicated workflows.

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
