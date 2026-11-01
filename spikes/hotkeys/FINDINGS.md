# GLIM-14 spike: global hotkeys, findings

Status: built and checked on headless Linux only. **Not yet run on Windows or macOS.** The user runs `TESTING.md` on real machines, and the results table there takes precedence over the expectations below.

Electrobun source read at `main` = [`3c4b81a`](https://github.com/blackboardsh/electrobun/tree/3c4b81a8eaaa141029a1c273f2522e77a59ac5ac) (v2.0.6-beta.8, 2026-10-29). The spike pins the latest stable npm release, **2.0.5** (tag commit `d06abc9`, 2026-10-25).

## 1. Electrobun's global shortcut implementation (current source)

The JS API is `GlobalShortcut.register(accelerator, cb): boolean`, plus `unregister`, `unregisterAll` and `isRegistered`. See [`package/src/sdks/main/proc/native.ts` L3085–3112](https://github.com/blackboardsh/electrobun/blob/3c4b81a8eaaa141029a1c273f2522e77a59ac5ac/package/src/sdks/main/proc/native.ts#L3085-L3112). The only result is a boolean: no error code, no reason. Native callbacks go through a `JSCallback` with `threadsafe: true` ([L3073–3081](https://github.com/blackboardsh/electrobun/blob/3c4b81a8eaaa141029a1c273f2522e77a59ac5ac/package/src/sdks/main/proc/native.ts#L3073-L3081)), because app JS runs in a Bun `Worker`, not on the main thread. The main thread runs the native event loop: [`package/src/launcher/main.ts` L249–256](https://github.com/blackboardsh/electrobun/blob/3c4b81a8eaaa141029a1c273f2522e77a59ac5ac/package/src/launcher/main.ts#L249-L256).

### macOS: the NSEvent finding holds

[`package/src/native/macos/nativeWrapper.mm` L10884–10953](https://github.com/blackboardsh/electrobun/blob/3c4b81a8eaaa141029a1c273f2522e77a59ac5ac/package/src/native/macos/nativeWrapper.mm#L10884-L10953) (`registerGlobalShortcut`) calls `[NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:…]` at L10918. Then:

- **It returns YES whenever a monitor object is created** (L10943–10948). That happens whether or not the process is trusted for Accessibility. It returns NO only for a key it doesn't know or a duplicate registration inside the same process. **It never calls `AXIsProcessTrusted`, and no conflict detection is possible.** Confirmed.
- **A global monitor only sees events delivered to other apps**, so it can't fire while Glimpse is frontmost. There is no complementary `addLocalMonitorForEvents` for shortcuts. The only local monitor in the file is the CEF fullscreen Esc handler at L7121. Confirmed.
- **Global monitors are observe-only:** the handler returns `void` and cannot swallow the event, so the focused app or game also receives `⌃⇧S`. Confirmed.
- **Key events need Accessibility trust.** Apple documents this for global key monitors. Recent macOS may list the app under *Input Monitoring* instead or as well; TESTING M1/M3 checks which. Unsigned or ad-hoc builds probably lose the grant when the code signature changes (M11). This part is inferred, not visible in source.
- **New: no auto-repeat filtering.** The handler never checks `event.isARepeat`, so holding the chord fires repeatedly. Windows passes `MOD_NOREPEAT`, so the two platforms behave differently (M6).
- **New: secure input.** Global monitors receive nothing while Secure Event Input is on (any focused password field, or Terminal's Secure Keyboard Entry). The hotkey silently dies there (M8).
- **New: threading.** `register` is called straight from the Bun worker thread over FFI. Nothing in `registerGlobalShortcut` hops to the main thread, so AppKit is called off the main thread. It probably works, but it's fragile.
- Matching is on the physical `keyCode` (hard-coded kVK_ANSI table) plus an exact match on the Cmd/Ctrl/Opt/Shift modifier set. Modifier mapping is in [L1254–1265](https://github.com/blackboardsh/electrobun/blob/3c4b81a8eaaa141029a1c273f2522e77a59ac5ac/package/src/native/macos/nativeWrapper.mm#L1254-L1265): `Control` → `NSEventModifierFlagControl`, so `Control+Shift+S` maps correctly.

**History.** The function body is byte-identical at `9c51500` (what GLIM-23 cited), `v2.0.5` and `3c4b81a`. I diffed the extracted function at each revision. Only the line numbers moved, from L10353/L10387 to L10884/L10918. `git log -L` on the function shows three commits: `1cbf77b` (race-condition fix), `9677519` ("Global shortcut support", 2026-01-04), and `baf2746` (2026-10-09, formatting reflow only). **Verdict: GLIM-23's finding is correct and still current. Four new gaps sit on top of it: auto-repeat, secure input, off-main-thread AppKit, and no `AXIsProcessTrusted` check.**

### Windows: `RegisterHotKey`, as GLIM-23 said

[`package/src/native/win/nativeWrapper.cpp` L15400–15720](https://github.com/blackboardsh/electrobun/blob/3c4b81a8eaaa141029a1c273f2522e77a59ac5ac/package/src/native/win/nativeWrapper.cpp#L15400-L15720) (L13823/L13960 at `v2.0.5`):

- A dedicated thread owns an `HWND_MESSAGE` window and a `GetMessage` pump. Registration is posted to that thread (`WM_REGISTER_HOTKEY`), which calls `RegisterHotKey(hwnd, id, mods, vk)` at L15510. The caller waits up to 5 s for the result.
- Modifiers always get `MOD_NOREPEAT` (L15647). `Alt`→`MOD_ALT`, `Shift`→`MOD_SHIFT`, `Control`/`CommandOrControl`→`MOD_CONTROL`, `Super`→`MOD_WIN`.
- **On failure the Win32 error is only logged** (`"Failed to register hotkey … Win32 error: N"`, L15516–15517), and JS gets `false`. Conflict detection works, but the reason (1409 = already registered, versus anything else) isn't available programmatically. That's good enough for GLIM-23's "show a conflict badge", though not to tell the user *why*.
- `WM_HOTKEY` calls the threadsafe JS callback from the hotkey thread. `RegisterHotKey` consumes the keystroke and fires regardless of which app is focused, Glimpse included.
- Electrobun never unregisters on quit by itself. `before-quit` in the spike calls `unregisterAll`. Windows frees the hotkeys at process exit anyway (W7 checks this, including after a kill).

### Linux (not a Glimpse target): `XGrabKey`

[`package/src/native/linux/nativeWrapper.cpp` L13084–13095](https://github.com/blackboardsh/electrobun/blob/3c4b81a8eaaa141029a1c273f2522e77a59ac5ac/package/src/native/linux/nativeWrapper.cpp#L13084-L13095). The code comments say a failure (X11 `BadAccess`) isn't detected, so it always reports success. There's no Wayland path. Noted only for the later Linux port.

### Packaging change worth knowing

Electrobun 2.x's npm package is just a bootstrap. The SDK and runtime come from **Hutch** (`~/.hutch`), which projects `.hutch/devkit/`. Importing `electrobun/main` from `node_modules` throws, so the TS config must extend `.hutch/devkit/tsconfig.json`. That devkit tsconfig uses `baseUrl`, which **TypeScript 7 rejects**, so the spike pins TypeScript `~5.9.3`. Builds are host-only (no cross-compile), and macOS 14 is the minimum.

## 2. What the spike contains

- `src/bun/index.ts` registers both GLIM-23 defaults and logs each press: ms timestamp, pid, backend, interval since the previous press, auto-repeat flag. Output goes to the console and `~/glimpse-hotkey-spike.log`. A counter window (inline HTML, which also lists the key events it received itself) and a tray / menu-bar menu (title `S<n> L<n>`) offer re-register / unregister / reset / switch backend / quit. Hotkeys are unregistered on `before-quit`. A failed registration triggers a notification and a *NOT registered* badge, following GLIM-23's failure handling.
- **Variant A** (`ElectrobunBackend`) is Electrobun's `GlobalShortcut`. On macOS it also reports `AXIsProcessTrusted()` through `bun:ffi`, which makes the silent failure visible.
- **Variant B** (`CarbonBackend`, macOS only) is `native/macos/glimhotkey.c`, about 200 lines of C. It is built with `clang` into a universal `libglimhotkey.dylib`, copied into the app bundle (`Resources/app/native/`), and `dlopen`ed with `bun:ffi`. It installs one `kEventHotKeyPressed/Released` handler on `GetApplicationEventTarget()` and registers with `RegisterEventHotKey(kVK, controlKey|shiftKey, …, kEventHotKeyExclusive)`. It returns the raw `OSStatus`, so `-9878 eventHotKeyExistsErr` reaches JS. All Carbon calls are moved onto the main queue (`dispatch_sync_f`), and the handler calls back into a `threadsafe` `JSCallback`. The same file builds a `glimhotkey-hold` CLI that holds a hotkey from another process for the conflict tests. A user can switch backends at runtime from the menu bar, or at launch with `GLIM_HOTKEY_BACKEND=carbon`.
- `src/shared/hotkeys.ts` holds the pure logic, unit-tested: defaults, accelerator parsing (rejects `CommandOrControl`, because GLIM-23 picks modifiers per OS), Electrobun / Carbon / display (`⌃⇧S`) conversions, OSStatus and Win32 error text, and the press log with the Live toggle state.
- `tools/hold-hotkey.ps1` holds a Windows hotkey with `RegisterHotKey` from PowerShell, for conflict tests. `tools/keylog.html` is a browser page that shows whether the hotkey's keystroke leaked to the focused app.

### Why a dylib for Carbon (lightest option that works)

| Option | Verdict |
|---|---|
| Raw `bun:ffi` into `Carbon.framework` | **Not workable on its own.** JS runs on a Worker thread, while Carbon event handlers are installed on, and dispatched from, the main thread's event loop. A `threadsafe` `JSCallback` can't run synchronously on the main thread or return an `OSStatus`, and a non-threadsafe one called from the main thread is unsafe. `RegisterEventHotKey` also takes the `EventHotKeyID` struct by value. Some C is needed either way. |
| `bun:ffi` `cc` (TinyCC at runtime) | It can't parse Apple's framework headers, and it would ship a compiler in the app. Rejected. |
| **Small C dylib + `bun:ffi`** (chosen) | About 200 lines, a single `clang` command (Xcode CLT), about 100 KB, no extra process, no IPC. It sits in the bundle like any other resource. The only cost is a native build step on macOS. |
| Swift/Rust sidecar over stdio | It works, but it's a second process with its own run loop, lifecycle (an orphaned sidecar keeps holding hotkeys), signing and IPC. Only worth it if Glimpse adopts a Rust sidecar anyway (then use the `global-hotkey` crate there). |
| Patch Electrobun's `nativeWrapper.mm` | The right long-term fix (an upstream PR to swap the NSEvent monitor for `RegisterEventHotKey`), but it means building Electrobun's native core (Zig + Xcode) from source. Too heavy for a spike. Recommended as follow-up. |

Electrobun 2.x also supports Rust, Zig and Go *main processes*. That's a heavier route to native code, and nothing in it is specific to hotkeys.

## 3. Verified here (headless Linux x64) vs not

Verified:

- Installed Bun 1.4.4 in user space (`~/.bun`). `bun install`, and `electrobun prepare` downloaded Hutch 0.28.2 and the Electrobun 2.0.5 core and devkit.
- `bun test`: 16 tests, 45 assertions pass (defaults, parsing, Carbon key/mod codes `⌃⇧S` = `0x01`/`0x1200`, `⌃⇧L` = `0x25`, status text, press log, auto-repeat heuristic, Live toggle, backend selection).
- `tsc --noEmit` passes against the Electrobun 2.0.5 devkit types: `GlobalShortcut`, `Tray`, `BrowserWindow({ html })`, `events.on("before-quit")`, and the `bun:ffi` signatures.
- `electrobun build --env=dev` succeeds for `linux-x64` without Node (`bun --bun`). The bundle includes the `bun:ffi` code paths.
- Checked that `build.copy` puts files at `Resources/app/native/`, where the Carbon backend looks for the dylib. Tested with a stand-in file, then reverted.
- `glimhotkey.c` (library and holder builds) passes `gcc -fsyntax-only -Wall -Wextra` against a hand-written shim of the Carbon/dispatch prototypes. This catches C mistakes, not API or ABI mismatches.

Not verified (needs the real OSes):

- Running the app at all. There's no display here, and no GTK/WebKitGTK to run even the Linux build.
- Compiling or linking the dylib against the real macOS SDK.
- Everything in the TESTING.md checklist.
- Specific unknowns:
  - the exact `kEventHotKeyExclusive` semantics across processes (C6/C7);
  - whether `dispatch_sync` to the main queue from the worker can deadlock during startup or shutdown (not expected; Electrobun's main thread runs a normal run loop);
  - the Windows Alt+Shift layout switch and Alt-menu side effects (W4, W8–W10);
  - anti-cheat or elevated games (W12);
  - whether the Electrobun tray shows usefully on Windows without an icon (the window is the main display anyway).

I didn't add a GitHub Actions workflow. Workflows only run from the repo-root `.github/workflows/`, and this spike must keep everything under `spikes/hotkeys/`.

## 4. Expected results per OS (before real testing)

| OS / variant | Expected | Why |
|---|---|---|
| **Windows: Electrobun `RegisterHotKey`** | **Pass, possibly partial** | Fires in any focused app and in Glimpse, consumes the keystroke, no repeat, conflicts reported as `false`, freed on exit. *Partial* risks: (1) the Alt+Shift input-language switch could trigger when the system sees Alt and Shift go down and up with the `S` swallowed. Reports say a third key suppresses the switch, but that's unverified (W8/W10). (2) Swallowing `S` can leave the foreground app seeing a bare Alt tap and activating its menu bar (W4). If so, fixes are an AutoHotkey-style "menu mask" dummy keystroke on fire, or GLIM-23's `Ctrl+Alt+F-key` fallback. (3) Games with low-level keyboard hooks or anti-cheat are unknown. (4) The conflict reason is only in the log, so Glimpse needs an upstream change or its own check for an error code. |
| **macOS A: Electrobun `NSEvent` monitor** | **Fail** (against GLIM-23's requirements) | Needs Accessibility (possibly lost on each unsigned rebuild) and fails silently without it. Doesn't consume the keystroke (the game or app also gets `⌃⇧S`). Doesn't fire while Glimpse is focused. Never reports conflicts. Floods on auto-repeat. Dead under secure input. It will "work" with permission in the plain case (M3, M9, M10), but that isn't enough to ship. |
| **macOS B: Carbon dylib** | **Pass, with partial conflict detection** | No permission, consumes the keystroke, fires everywhere including Glimpse, one event per press, works under secure input, freed on exit. Conflict detection only covers other Carbon registrants (`eventHotKeyExistsErr` with the exclusive option). System and app shortcuts and other apps' NSEvent monitors or event taps are invisible to it (C8), as GLIM-23 already expected. Carbon hot keys are legacy but still not deprecated for removal, and widely used (e.g. sindresorhus/KeyboardShortcuts). |

**Implication for the architecture decision.** Hotkeys alone don't sink Electrobun. Windows is fine as-is, and macOS needs about 200 lines of native C, either shipped as a dylib (this spike) or upstreamed. If the other spikes push Glimpse to a Rust sidecar, fold hotkeys into it with `global-hotkey`. That crate is Carbon on macOS and `RegisterHotKey` on Windows, and it returns typed errors.
