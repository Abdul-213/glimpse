# GLIM-111: the Visual C++ runtime on Windows

Status: decided (2026-11-01). Owner check needed: the licence point under "Licence".

## Problem

onnxruntime-node 1.31.1's `onnxruntime.dll` and `onnxruntime_binding.node` import the Microsoft
Visual C++ runtime. From their PE import tables (`app/scripts/pe-imports.ts`):

| Target | Visual C++ runtime DLLs imported |
|---|---|
| win32-x64 | msvcp140, msvcp140_1, msvcp140_atomic_wait, vcruntime140, vcruntime140_1 |
| win32-arm64 | msvcp140, msvcp140_1, msvcp140_atomic_wait, vcruntime140 |

None of these ship with Windows (the UCRT `api-ms-win-crt-*` DLLs do). On a PC without the
"Visual C++ 2015-2022 Redistributable" (common on fresh installs, but many games and apps
install it), the OCR Worker fails to load the binding with "The specified module could not be
found", so local OCR doesn't work.

`glimpse.dll` (our own helper) also linked the DLL runtime (`cl /LD` defaults to `/MD`).

## Options

1. **App-local copies**: ship the DLLs next to `onnxruntime.dll`. Windows looks for a DLL's
   imports in that DLL's own folder first when it is loaded by full path (Bun/Node load `.node`
   addons that way), so the copies are used, without installing anything.
2. **Install the redistributable** from the installer (`vc_redist.x64.exe /install /quiet`).
   Electrobun's installer has no hook for running a prerequisite, it needs admin rights (UAC),
   and the portable zip would still not work.
3. **Tell the user**: detect the failure and show "install the Visual C++ Redistributable" with a
   link. Honest, but it makes a first-run step for a large share of users, for a problem we can
   solve.

## Decision

Option 1, with option 3 as the fallback message:

- `scripts/onnxruntime.ts` reads the import tables of the staged Windows files and copies exactly
  the Visual C++ runtime DLLs they import from the build machine's Visual Studio redist folder
  (`%VCToolsRedistDir%<arch>\Microsoft.VC14x.CRT`, set by a VS developer prompt and by
  `ilammy/msvc-dev-cmd` in desktop.yml; else a VS 2022+ install under Program Files; or
  `GLIMPSE_VCRT_DIR`). A stable/canary build without one fails; a dev build warns.
- `glimpse.dll` is built with `/MT` (static runtime), so it needs nothing.
- If loading still fails with a missing-DLL error, the OCR provider's error (log, diagnostics)
  names the Visual C++ runtime and the download link (`load-failure.ts`).
- desktop.yml runs `scripts/bundle-smoke.ts` after the Windows build: one OCR call through the
  staged files, checking that the runtime DLLs in the process's module list are the app-local
  ones.

Microsoft prefers central deployment (the redistributable) because Windows Update then services
the DLLs; app-local copies are only updated when we ship a new build. Each Glimpse build copies
the newest runtime the runner's Visual Studio has, and if the PC already has a newer runtime
loaded in the process, Windows uses that one.

Checked on GitHub's windows-latest runner (desktop.yml, 2026-11-01): the build copied the five
DLLs from `Visual Studio\18\Enterprise\VC\Redist\MSVC\14.51.36231\x64\Microsoft.VC145.CRT`,
and the OCR smoke test's module list showed all five loaded from the app's
`native\onnxruntime\`, not System32 (the runner also has the redistributable installed).

## Licence

The Visual Studio licence terms ("Distributable Code"; checked for 2022, the runners now have
Visual Studio 18 / 2026, whose terms should be confirmed to say the same) and the REDIST list
(<https://learn.microsoft.com/visualstudio/releases/2022/redistribution>) allow distributing
"any of the files within [VisualStudioFolder]\VC\redist", unmodified, with your program. The
conditions in the licence: distribute them only with a program that adds significant
functionality, unmodified, and under terms that protect them at least as much as Microsoft's;
no Microsoft trademarks. Microsoft's guidance adds that distribution "is limited to licensed
Visual Studio users"
(<https://learn.microsoft.com/cpp/windows/redistributing-visual-cpp-files>).

What we do about that:

- The files come only from a Visual Studio redist folder, never from System32.
- `NOTICE.txt` lists them, says they are Microsoft's, not MIT, and may not be modified or
  redistributed apart from Glimpse except as Microsoft's terms allow.
- **For the owner:** the builds run on GitHub's runners, whose Visual Studio is licensed by
  GitHub/Microsoft for that use. The owner, as the distributor, should hold a Visual Studio
  licence; Visual Studio Community is free for individual developers and open-source projects.
  If that is not acceptable, revert to option 3: delete the `stageVcRuntime` call in
  `scripts/prebuild.ts`; the fallback message stays.

## Unverified

On a clean Windows 10/11 VM without the redistributable (GLIM-87 manual pass): install from the
setup zip and from the portable zip, Snip some text, and check local OCR reads it. CI can only
show that the app-local copies are the ones loaded on a runner that also has the redistributable.
