# GLIM-14 spike: global hotkeys, test plan

Throwaway spike. It answers one question: can an Electrobun app register Glimpse's two default global hotkeys (GLIM-23) reliably on Windows and macOS? What we find also feeds the shell decision.

| | Windows | macOS |
|---|---|---|
| Snip | `Alt+Shift+S` | `⌃⇧S` (Control+Shift+S) |
| Live toggle | `Alt+Shift+L` | `⌃⇧L` (Control+Shift+L) |

One app, two hotkey **backends** (the "variants"):

- **A: `electrobun`.** Electrobun 2.0.5's built-in `GlobalShortcut`. It uses `RegisterHotKey` on Windows and an `NSEvent` global monitor on macOS. This is the default at launch.
- **B: `carbon` (macOS only).** Carbon `RegisterEventHotKey` through a small C dylib (`native/macos/glimhotkey.c`) loaded with `bun:ffi`. To switch, use the menu-bar menu (**Switch to carbon backend**) or launch with `GLIM_HOTKEY_BACKEND=carbon`.

On Windows there is no variant B. Electrobun already uses `RegisterHotKey` there, which is the proper API.

What the app shows:

- **Counter window.** Snip and Live counts, registered / NOT registered status (hover for details), Live pinned/unpinned state, a press log, a list of the key events the window itself received, and diagnostics.
- **Tray / menu bar.** The macOS menu-bar title reads `S<n> L<n>`. The menu shows counts and status and offers re-register / unregister / reset / switch backend / quit.
- **Log file.** Every registration result and every press is logged with a millisecond timestamp, pid and backend:
  - Windows: `%USERPROFILE%\glimpse-hotkey-spike.log`
  - macOS: `~/glimpse-hotkey-spike.log`

  A press is flagged `LIKELY-AUTOREPEAT` when it comes less than 120 ms after the previous one. Electrobun's own native log lines (for example `Win32 error: 1409`) go to the terminal when you use `dev`.
- **`tools/keylog.html`.** Open this in any browser and focus it. It shows every keydown/keyup the browser receives. If the hotkey's `S`/`L` keydown appears there (highlighted red), the keystroke was **not** consumed.

---

## Build and run: Windows

Prerequisites:

- Windows 10 or 11, x64 or arm64.
- WebView2 Runtime. Windows 11 has it preinstalled; on Windows 10, get it from https://developer.microsoft.com/microsoft-edge/webview2/.
- Git.
- Bun 1.4.x: `powershell -c "irm bun.sh/install.ps1 | iex"`, then open a new terminal.
- Node.js is **not** required if you use `bun --bun` as shown below.

```powershell
git clone https://github.com/Abdul-213/glimpse.git
cd glimpse
git checkout glim-14-hotkeys-spike
cd spikes\hotkeys
bun install
bun --bun run prepare:devkit   # first run downloads Hutch + Electrobun 2.0.5 into %USERPROFILE%\.hutch
bun test                       # pure-logic unit tests (16 tests)
bun --bun run typecheck
bun --bun run dev              # builds build\dev-win-*\ and launches with logs in this terminal
```

`bun --bun run build` only builds. To start a second copy (for test W6), launch the built `.exe` under `build\dev-win-*\` again (search that folder for `*.exe`), or run `bun --bun run dev` in a second terminal.

## Build and run: macOS

Prerequisites:

- macOS 14 or later (Electrobun 2.x minimum), Apple Silicon or Intel.
- Xcode Command Line Tools: `xcode-select --install`. This provides `clang` for the Carbon dylib.
- Bun 1.4.x: `curl -fsSL https://bun.sh/install | bash`.

```bash
git clone https://github.com/Abdul-213/glimpse.git
cd glimpse && git checkout glim-14-hotkeys-spike
cd spikes/hotkeys
bun install
bun --bun run prepare:devkit   # first run downloads Hutch + Electrobun 2.0.5 into ~/.hutch
bun test
bun --bun run typecheck
bun run native:mac             # builds native/macos/build/libglimhotkey.dylib (+ glimhotkey-hold)
bun --bun run build            # builds build/dev-macos-*/…app and copies the dylib into it
ls build/dev-macos-*/          # note the .app name
open build/dev-macos-*/*.app   # launch like a real app
```

> **Launch from Finder or `open`, not from Terminal, for the permission tests.** If you start the app from Terminal (`bun run dev`), macOS attributes its Accessibility / Input Monitoring requests to Terminal. If Terminal is already trusted, variant A will appear to work. `bun --bun run dev` is still fine for quick looks and to see native logs.

- **Second copy (tests M7/C6):** `open -n build/dev-macos-*/*.app`.
- **Holder tool (tests C6/C7):** `native/macos/build/glimhotkey-hold <keyCode> <carbonMods> <exclusive 0|1>` holds a Carbon hot key from a separate process. `⌃⇧S` = `1 4608`, `⌃⇧L` = `37 4608` (0x1200 = controlKey|shiftKey). Example: `native/macos/build/glimhotkey-hold 1 4608 1`. Ctrl+C releases it.
- **Reset permissions between runs:** `tccutil reset Accessibility dev.glimpse.spike.hotkeys` and `tccutil reset ListenEvent dev.glimpse.spike.hotkeys`. The bundle id may get a channel suffix; check the `.app`'s `Info.plist` if the reset does nothing.

---

## Manual checks

For every check, record the press log line(s) from the window or the log file. "Fires" means the counter increments once per physical press.

### Windows (variant A: Electrobun → `RegisterHotKey`)

Before W8–W10, install the input languages: Settings → Time & language → Language & region → add **Japanese** (Microsoft IME) and **Polish** (keyboard "Polish (Programmers)"). Then go to Settings → Time & language → Typing → Advanced keyboard settings → *Input language hot keys* and confirm that **Between input languages = Left Alt+Shift** (the default). Write down the setting you tested with.

| # | Check | Steps | Expected |
|---|---|---|---|
| W1 | Registration | Launch. | Both cards say *registered*. The log shows `register snip Alt+Shift+S via electrobun: OK`, and the same for live. |
| W2 | Fires with another app focused | Focus Notepad, press `Alt+Shift+S`, then `Alt+Shift+L`. | Snip +1, Live +1, Live shows PINNED. Press `Alt+Shift+L` again → unpinned. |
| W3 | Keystroke consumed? | Open `tools/keylog.html` in Edge/Chrome, focus it, press both hotkeys. | No red `KeyS`/`KeyL` keydown rows; you may see Alt/Shift down/up only. Counter increments. |
| W4 | Alt menu side effect | Focus Notepad (classic menu bar or Win11 Notepad), press `Alt+Shift+S` and release. | The menu bar should **not** activate (no underlined access keys, no focus on File). Record what you see. |
| W5 | Glimpse itself focused | Click the spike window, press both hotkeys. | Fires. The window's "key events received" list shows no `KeyS`/`KeyL` keydown. |
| W6 | Conflict detection | (a) Run `powershell -ExecutionPolicy Bypass -File tools\hold-hotkey.ps1` (it holds Alt+Shift+S), then launch the spike. (b) Separately, with the spike running, start a second copy. | (a) Snip card says *NOT registered*, a notification appears, and the terminal shows `Win32 error: 1409`. Live is registered. (b) The second copy shows both *NOT registered*. The first copy keeps working. |
| W7 | Unregister on quit | Spike running → tray menu **Quit** (or close it from the terminal with Ctrl+C). Then run `tools\hold-hotkey.ps1` and `tools\hold-hotkey.ps1 -Key L`. | The log shows `before-quit: electrobun hotkeys unregistered`. Both holder runs print *Holding…* (they register successfully). Also try killing the spike in Task Manager, then run the holder: it should still succeed (the OS frees it). |
| W8 | Alt+Shift layout switch, EN + JA | Set the active input to ENG. Focus Notepad. Press `Alt+Shift+S` 5 times, then `Alt+Shift+L` 5 times. Watch the taskbar language indicator. | Hotkey fires every time. The input language does **not** change (stays ENG). Then press `Alt+Shift` alone and confirm that **does** switch, which proves the switch hotkey is active. |
| W9 | Same with Japanese IME active | Switch to JA (Microsoft IME, Hiragana mode on), focus Notepad, press both hotkeys. | Fires. The IME mode does not change and no composition starts. |
| W10 | Alt+Shift layout switch, EN + PL | Remove JA (or keep it; note it), keep EN + PL. Repeat W8. Then, with PL active, type `AltGr+S` in Notepad. | Hotkey fires, the layout does not switch, and `AltGr+S` types `ś` (AltGr = Ctrl+Alt, not our chord). |
| W11 | Fullscreen video | Play a YouTube video fullscreen in a browser (F11 or the fullscreen button), and separately a local video in Films & TV / VLC fullscreen. Press both hotkeys. | Fires. The video stays fullscreen; nothing pauses or seeks (S and L are not media keys there). |
| W12 | Fullscreen game | Any game in **exclusive fullscreen** and in **borderless**. If you have one, also a game with anti-cheat (EAC/BattlEye/Vanguard) or one running elevated. Press both hotkeys in-game, then Alt-Tab out and read the counter. | Fires in borderless. Exclusive fullscreen: should fire (record if the game minimises; that's not a hotkey problem). Anti-cheat/elevated: unknown, record it. |
| W13 | Holding the key | Hold `Alt+Shift+S` for 2 s. | Exactly one press (Electrobun passes `MOD_NOREPEAT`). No `LIKELY-AUTOREPEAT`. |
| W14 | Unregister/re-register at runtime | Tray → *Unregister hotkeys*, press both (nothing). Tray → *Re-register*, press both. | No fire while unregistered, fires after. |

### macOS variant A (Electrobun → `NSEvent addGlobalMonitorForEvents`)

Start from a clean permission state (`tccutil reset …` above). Launch with `open` (see the note above).

| # | Check | Steps | Expected (from source reading) |
|---|---|---|---|
| M1 | Registration result vs reality | Launch. Look at the diagnostics: `AXIsProcessTrusted() = …`. | Both cards say *registered* **even though** AX is `false`. Record whether macOS prompts, and which pane the app appears in under System Settings → Privacy & Security: **Accessibility** or **Input Monitoring**. |
| M2 | Fires without permission? | Before granting anything, focus TextEdit and press `⌃⇧S`. | **Does not fire** (silent failure). |
| M3 | Grant and retry | Grant the app Accessibility (and Input Monitoring if it is listed). Quit and relaunch, then repeat M2. | Fires. Record exactly which permission was needed and whether a relaunch was needed. |
| M4 | Keystroke consumed? | Focus `tools/keylog.html` in Safari/Chrome, press both hotkeys. | **Not consumed**: red `KeyS` / `KeyL` rows appear and the counter also increments. |
| M5 | Glimpse itself focused | Click the spike window, press both. | **Does not fire.** The window's key list shows the `KeyS`/`KeyL` keydown. |
| M6 | Holding the key | Hold `⌃⇧S` for 2 s with TextEdit focused. | **Multiple presses** flagged `LIKELY-AUTOREPEAT` (Electrobun does not filter `isARepeat`). |
| M7 | Conflict detection | (a) Launch a second copy (`open -n …`), both in variant A. (b) Quit it, run the holder `glimhotkey-hold 1 4608 1`, then relaunch the spike in variant A. | Variant A says *registered* in every case; no conflict is ever reported. Record which processes fire (both copies? spike and holder?). |
| M8 | Secure input | Focus a password field (Safari login page, or Terminal → *Secure Keyboard Entry*), press `⌃⇧S`. | **Does not fire** while secure input is on. |
| M9 | Fullscreen video | Safari/YouTube fullscreen, QuickTime fullscreen. | Fires (with permission). The keystroke also reaches the player (harmless there). |
| M10 | Fullscreen game | Any fullscreen game (Steam, Apple Arcade, or an emulator). | Fires (with permission). The game also receives `⌃⇧S`. |
| M11 | Permission survives rebuild? | Edit nothing, run `bun --bun run build` again, relaunch with `open`, press `⌃⇧S` with TextEdit focused. | Likely **lost** (ad-hoc signature changes on rebuild). Record whether it still fires and what System Settings shows. |
| M12 | Unregister on quit | Quit from the menu bar. | The log shows `before-quit: electrobun hotkeys unregistered`. (Nothing system-wide to verify for an NSEvent monitor.) |

### macOS variant B (Carbon `RegisterEventHotKey`)

Menu bar → **Switch to carbon backend**. The log shows `register … via carbon: OK - RegisterEventHotKey(…) -> noErr`. For a cleaner test, also reset permissions and confirm AX is `false` in the diagnostics.

| # | Check | Steps | Expected |
|---|---|---|---|
| C1 | No permission needed | With AX `false` (diagnostics), focus TextEdit, press `⌃⇧S`, `⌃⇧L`, `⌃⇧L`. | Fires all three times; Live goes pinned → unpinned. No permission prompt. |
| C2 | Keystroke consumed | Focus `tools/keylog.html`, press both. | **No** red `KeyS`/`KeyL` rows. Counter increments. |
| C3 | Glimpse itself focused | Click the spike window, press both. | **Fires.** The window's key list does not show the `KeyS`/`KeyL` keydown. |
| C4 | Holding the key | Hold `⌃⇧S` 2 s. | Exactly one press. |
| C5 | Secure input | Password field focused (as M8), press `⌃⇧S`. | Fires (Carbon hot keys are not blocked by Secure Event Input). The diagnostics (refreshed on every press) show `IsSecureEventInputEnabled() = true`. |
| C6 | Conflict detection: two copies | Copy 1 in carbon mode. Launch copy 2 (`open -n …`) and switch it to carbon. Then repeat in the other order. | Copy 2 shows *NOT registered* with `eventHotKeyExistsErr` (both copies register with `kEventHotKeyExclusive`). Copy 1 keeps firing. If both register OK, record **which one fires**. |
| C7 | Conflict detection: holder, both option modes | Quit all copies. (a) `glimhotkey-hold 1 4608 1` (exclusive), then launch the spike in carbon mode. (b) Same with `glimhotkey-hold 1 4608 0` (non-exclusive). | (a) Spike Snip *NOT registered* (`-9878`). (b) Record: does the spike register, and who fires (spike, holder, or both)? |
| C8 | System shortcut collision | Temporarily bind ⌃⇧S to something in System Settings → Keyboard → Keyboard Shortcuts (e.g. App Shortcuts → "Show Help menu" for All Applications). Re-register in the spike. | Expected: Carbon still reports `noErr` (it does not see system/app shortcuts; GLIM-23 calls this out). Record which action wins. Remove the binding afterwards. |
| C9 | Japanese IME | Add Japanese – Romaji input, switch to it (Hiragana), focus TextEdit, press `⌃⇧L` and `⌃⇧S`. Repeat with Google Japanese Input if installed. | Fires; the input mode does not change and no stray characters appear. (`⌃⇧J` is the IME's Hiragana key; L and S should be free.) |
| C10 | Fullscreen video | Safari/YouTube and QuickTime fullscreen. | Fires; the player does not receive the keystroke. |
| C11 | Fullscreen game | Any fullscreen game. | Fires; the game does not receive the keystroke. |
| C12 | Survives rebuild without permission | Rebuild, relaunch, switch to carbon, press. | Fires (no permission involved). |
| C13 | Unregister on quit / runtime | (a) Menu → *Unregister hotkeys*, press (nothing), *Re-register*, press (fires). (b) Quit, then run `glimhotkey-hold 1 4608 1`. (c) Kill the app with `kill -9 <pid>` (pid is in the diagnostics), then run the holder again. | (a) as described. (b) The log shows `before-quit: carbon hotkeys unregistered` and the holder registers OK. (c) The holder registers OK (the OS frees hot keys of dead processes). |
| C14 | Switch back to A | Menu → *Switch to electrobun backend*, press `⌃⇧S` in TextEdit. | Behaves like variant A again, which shows the backends are independent. |

---

## Results (fill in)

Result: **pass** / **partial** / **fail**. Put the OS version, keyboard, and game/app names in the notes.

Machine details. Windows: ______ (build ____, layouts ______). macOS: ______ (version ____, chip ____).

### Windows

| # | Result | Notes |
|---|---|---|
| W1 | | |
| W2 | | |
| W3 | | |
| W4 | | |
| W5 | | |
| W6 | | |
| W7 | | |
| W8 | | |
| W9 | | |
| W10 | | |
| W11 | | |
| W12 | | |
| W13 | | |
| W14 | | |

### macOS variant A (Electrobun / NSEvent)

| # | Result | Notes |
|---|---|---|
| M1 | | |
| M2 | | |
| M3 | | |
| M4 | | |
| M5 | | |
| M6 | | |
| M7 | | |
| M8 | | |
| M9 | | |
| M10 | | |
| M11 | | |
| M12 | | |

### macOS variant B (Carbon)

| # | Result | Notes |
|---|---|---|
| C1 | | |
| C2 | | |
| C3 | | |
| C4 | | |
| C5 | | |
| C6 | | |
| C7 | | |
| C8 | | |
| C9 | | |
| C10 | | |
| C11 | | |
| C12 | | |
| C13 | | |
| C14 | | |

### Summary

| OS / variant | Overall (pass / partial / fail) | Blocking issues |
|---|---|---|
| Windows: Electrobun `RegisterHotKey` | | |
| macOS: Electrobun `NSEvent` (A) | | |
| macOS: Carbon dylib (B) | | |
