# Contributing to Glimpse

Read [ARCHITECTURE.md](ARCHITECTURE.md) first; it is binding. Product and design rules are in
[PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md), decisions in [docs/decisions/](docs/decisions/).

## Setup

You need [Bun](https://bun.sh) 1.4.4 and [Hutch](https://hutch.blackboard.sh) (Electrobun's CLI;
it downloads the pinned Electrobun core, SDK and its own Bun, so no C/C++ toolchain is needed to
build the app).

```sh
# Hutch (macOS/Linux); Windows: & ([scriptblock]::Create((irm https://hutch.blackboard.sh/hutch/install.ps1)))
curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh

bun install            # Bun workspace: app/, packages/*
bun run devkit         # hutch electrobun sync in app/: Electrobun 2.0.6-beta.2 devkit -> app/.hutch/
```

Windows 10 needs the WebView2 Evergreen runtime (Windows 11 has it).

### Native helpers (Windows and macOS only)

Screen capture needs the per-OS helper library (ARCHITECTURE.md section 6). Build it once, and
again whenever `app/native/<os>/` changes; without it the app runs but capture is unavailable.

```sh
# macOS (Xcode Command Line Tools: xcode-select --install)
sh app/native/macos/build.sh                 # -> app/native/macos/build/libglimpse.dylib

# Windows: Developer PowerShell for VS (MSVC), or zig on PATH
pwsh app/native/windows/build.ps1            # -> app/native/windows/build/glimpse.dll

# Any OS with zig: check the Windows helper compiles
ZIG=/path/to/zig sh app/native/windows/build-zig.sh
```

`bun app/scripts/native-smoke.ts --try-capture` loads the built helper through the real bindings
and tries one small capture.

## Everyday commands (repo root)

| Command | What it does |
|---|---|
| `bun run dev` | Build views and launch the app with rebuild-on-change (`hutch electrobun dev --watch`) |
| `bun run build` | Dev build of the app into `app/build/` (`hutch electrobun build --env=dev`) |
| `bun run typecheck` | `tsc --noEmit` in every package |
| `bun run lint` | Biome lint + format check (`bun run fix` applies safe fixes) |
| `bun run format` | Biome format, in place |
| `bun test` | All unit tests (spikes/ and .hutch/ are excluded by bunfig.toml) |
| `bun run tokens` | Regenerate `packages/ui/src/styles/tokens.css` after editing DESIGN.md |
| `bun run harness <displays\|snip\|live>` | Headless harness: Snip/Live over recorded frames, no window or webview (see below) |

`cd app && bun run views` builds only the webviews into `app/dist/views/`.

Run `typecheck`, `lint` and `bun test` before pushing; CI runs the same on Linux.

ONNX Runtime's official builds send usage telemetry to Microsoft unless `ORT_DISABLE_TELEMETRY=1`
is set (GLIM-112). The app and `bun test` set it themselves; when you run a script that loads
onnxruntime directly (`packages/providers/scripts/*`), export it in your shell first.

## Headless harness (Linux, CI, quick checks anywhere)

The harness drives the main-process services without Electrobun or a webview. On Linux, capture
comes from the file-based backend: a folder of PNG "screenshots" plus an optional `frames.json`
describing the displays and timing (format in `app/src/bun/services/capture/file.ts`).

```sh
bun run harness displays                                   # the sample recording's display layout
bun run harness snip --rect 20,15,160,90 --out /tmp/glim   # one capture, saved as PNG
bun run harness live --rect 0,0,360,120 --fps 4            # a Live session: new vs unchanged frames
bun run harness live --frames ~/recordings/game --realtime # your own recording, real timing
bun run harness snip --native --rect 0,0,400,200 --out out # Windows/macOS: the real capture backend
```

Add `--json` for the full report. The app honours the same switches:
`GLIMPSE_CAPTURE_FRAMES=<folder> bun run dev` runs it on recorded frames.

## Getting a Windows or macOS build

You don't need a local toolchain to try Glimpse on a real PC or Mac: `.github/workflows/desktop.yml`
(GLIM-34, GLIM-50) builds it on GitHub's Windows and macOS runners. It typechecks, runs the unit
tests, builds the native helper and makes a release build (`hutch electrobun build --env=stable`),
then uploads **unsigned** artifacts, kept for 14 days:

| Artifact | What it is |
|---|---|
| `glimpse-<version>-<sha>-windows-x64.zip` | Portable app. Unzip it anywhere and run `Glimpse\bin\launcher.exe`. |
| `glimpse-<version>-<sha>-windows-x64-setup.zip` | Electrobun's installer: unzip, run `Glimpse-Setup.exe`. |
| `glimpse-<version>-<sha>-macos-arm64.zip` | `Glimpse.app`, ad-hoc signed, Apple Silicon only. Move it to Applications first. |
| `glimpse-<version>-<sha>-macos-arm64.dmg` | The same app in a disk image. |

There is no Intel macOS build yet: onnxruntime-node ships no darwin-x64 binary (GLIM-89).

Release builds are Electrobun's self-extracting wrappers: the first launch unpacks the real app
(`Resources/<hash>.tar.zst`) and starts it, so the first start is slower. On macOS the
launcher unpacks the real app into Application Support and installs it in place of the wrapper
(same path). Electrobun leaves that inner app unsealed, so desktop.yml unpacks the archive after
the build, ad-hoc seals the inner `Glimpse.app` and packs it back
(`app/scripts/macos-seal-inner.sh`, GLIM-113); a first-launch step on the runner then checks the
installed app verifies with `codesign --verify --deep --strict`.

**When it runs.** Windows minutes cost 2x and macOS 10x on the free plan, so it never runs on PRs.
It runs on pushes to `develop` that change `app/`, `packages/`, `package.json`, `bun.lock` or the
workflow, and on demand: Actions -> Desktop builds -> Run workflow, or
`gh workflow run desktop.yml -R Abdul-213/glimpse --ref develop` (manual runs need the workflow on
the default branch). Pick a run and download the artifacts from its summary page, or
`gh run download <run-id> -R Abdul-213/glimpse`.

**Opening an unsigned build.** The builds aren't code-signed or notarized. The full user-facing steps per OS version are in [docs/install.md](docs/install.md); in short:

- Windows: SmartScreen says "Windows protected your PC". Choose *More info* -> *Run anyway*.
- macOS: Gatekeeper blocks a downloaded unsigned app. Either remove the quarantine flag
  (`xattr -dr com.apple.quarantine /Applications/Glimpse.app`) or try to open it once, then allow
  it in System Settings -> Privacy & Security -> *Open Anyway*. Screen capture needs the Screen
  Recording permission the first time.

## Releases

`.github/workflows/release.yml` (GLIM-62) turns a version tag into a **draft** GitHub Release:

1. Under `## [Unreleased]` in `CHANGELOG.md`, write what changed for users; move it under a new
   `## [x.y.z] - <date>` heading. Set the same version in `package.json` and `app/package.json`.
2. Merge to `main`, then tag the merge commit `v<x.y.z>` and push the tag.
3. The workflow checks the tag matches the version, runs the desktop.yml builds, renames the
   artifacts to `glimpse-<version>-<target>.<ext>`, writes `SHA256SUMS` and the notes (the
   changelog section, or a list generated from the `GLIM-<n>:` commits since the last tag), and
   creates the draft. Review it on the Releases page and publish it by hand.

A manual run (Actions -> Release -> Run workflow, once the file is on the default branch) does
the same without creating a release and uploads the files as a `release-preview` artifact.

## Branches, commits, PRs

- Work happens in Jira space **GLIM**. One ticket per branch: `glim-<n>-<slug>`, branched from
  the latest `develop`. PRs target `develop`, titled `GLIM-<n>: <summary>`. `main` only receives
  releases.
- Keep PRs to one ticket. New work you find becomes a new ticket, linked from the PR.
- Every PR description says: what it does, how it was tested, **what is unverified on real
  Windows/macOS hardware**, and follow-up tickets.
- Don't change `spikes/`; they are frozen references.

## Code rules (short version)

- TypeScript strict; no `any` or `!` without a comment. Biome decides formatting.
- `@glimpse/core` stays pure (no Electrobun, `bun:*`, `node:*`, DOM); Biome enforces it.
  OS access goes through ports implemented in `app/src/bun/services/`.
- OS-specific code is guarded by `process.platform` and lives under `app/src/bun/native/`,
  `app/src/bun/services/` or `app/native/<os>/`. It must still typecheck and not crash on Linux.
- Never import `electrobun/main` from a test.
- UI uses the DESIGN.md tokens through Tailwind utilities only: no raw colours, no off-scale sizes,
  logical properties for layout. Use the Impeccable skill (`.claude/skills/impeccable`) for UI work.
- Code that can only be checked on Windows/macOS gets manual test steps in the ticket and is called
  out as unverified in the PR.

## Licence

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
Third-party models downloaded at runtime keep their own licences (for example, Firefox
Translations models are MPL-2.0; see docs/decisions/GLIM-85-translation-model.md).
