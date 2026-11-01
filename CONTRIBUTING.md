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

`cd app && bun run views` builds only the webviews into `app/dist/views/`.

Run `typecheck`, `lint` and `bun test` before pushing; CI runs the same on Linux.

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
