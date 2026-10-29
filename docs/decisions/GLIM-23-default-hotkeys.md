# GLIM-23 — Decision: default hotkeys

Status: **Accepted** (2026-10-30) · Proposed: 2026-10-25 · Scope: Windows + macOS

## Recommendation

| Action | Windows default | macOS default | Scope |
|---|---|---|---|
| **Snip** (one-shot region → popup + clipboard) | `Alt+Shift+S` | `⌃⇧S` (Control+Shift+S) | Global |
| **Live** (pin region) — **toggle**: press again to unpin | `Alt+Shift+L` | `⌃⇧L` (Control+Shift+L) | Global |
| Pause/resume Live, re-snip last region, show/hide Live popup | *unbound* (user can assign) | *unbound* | Global, opt-in |
| Cancel picker / dismiss Snip popup | `Esc` | `Esc` | Glimpse surface only |
| Confirm keyboard-drawn selection | `Enter` | `Return` | Picker only |
| Move selection (1 px / 10 px) | `Arrows` / `Shift+Arrows` | same | Picker only |
| Resize selection (1 px / 10 px) | `Alt+Arrows` / `Alt+Shift+Arrows` | `⌥+Arrows` / `⌥⇧+Arrows` | Picker only |
| Switch Snip ↔ Live before confirming | `Tab` (or press the other mode's hotkey) | same | Picker only |
| Copy translation | `Ctrl+C` | `⌘C` | Popup focused |
| Copy original (OCR) text | `Ctrl+Shift+C` | `⌘⇧C` | Popup focused |
| Toggle original / translation view | `Ctrl+Shift+O` | `⌘⇧O` | Popup focused |
| Pause/resume Live | `Ctrl+Shift+P` | `⌘⇧P` | Live popup focused |
| Unpin Live (same as global toggle) | `Ctrl+W` | `⌘W` | Live popup focused |
| Return focus to previous app (Live keeps running) | `Esc` | `Esc` | Live popup focused |

Summary of the decisions:

- **Two global hotkeys by default, not three.** Live is a toggle. If no region is pinned, the hotkey opens the picker in Live mode. If one is pinned, it unpins. Re-pinning a different region takes two presses (unpin, then pin). A pinned Live popup should not need focus, so stopping has to work from a global key while a game has focus, and a toggle does that without a third global chord.
- **Same letters on both OSes, modifiers picked per OS.** The usual `Ctrl ↔ ⌘` mapping is not used. On macOS it gives `⌘⇧S`, which is Save As / Duplicate in nearly every app. On Windows, `Ctrl+Shift+S` is Save As (and reportedly AMD's instant-replay hotkey). Each OS gets the least-conflicting modifier pair, and the UI shows OS-native glyphs.
- **Keys inside Glimpse surfaces follow the OS (`Ctrl` on Windows, `⌘` on macOS)** and are never registered globally. `Esc`, `Enter` and arrows must never become global hotkeys.

## Reasoning

What we wanted from the defaults:

1. **No OS-reserved combos.** That rules out every `Win+` combo on Windows. Microsoft reserves them for the OS and keeps adding new ones; Capture2Text's old `Win+Q` default now opens Search. On macOS it rules out the `⌘⇧3/4/5/6`, `⌘⇧Space`, Spotlight and input-source families.
2. **Layout-safe.** On Windows, `AltGr` is sent as `Ctrl+Alt`, so any `Ctrl+Alt+letter` (or `Ctrl+Alt+Shift+letter`) hotkey swallows characters such as Polish ś (`AltGr+S`) and ł, and German `@`/`€`. On macOS, `⌥+letter` and `⌥⇧+letter` type characters (US ß, Polish Pro ą ś ł…). Sequoia also rejects hotkeys whose only modifiers are ⌥ or ⌥⇧. Apple says 15.2 relaxed this, but developers still report failures.
3. **Survives fullscreen games.** Games and "game mode" keyboards commonly disable the Win key, and games often filter keys with `WH_KEYBOARD_LL` hooks. They rarely touch Alt+Shift. Letters were kept off the WASD/QE cluster so that sprint + free-look (`Shift+W` while holding `Alt`, as in PUBG/ARMA) can't fire a hotkey by accident. `S` is the one exception, kept for its mnemonic because sprinting backwards is rare.
4. **Clear of popular tools and apps.** See the matrix below.
5. **Easy to remember and reach.** S = Snip, L = Live. Both use one modifier pair per OS. On Windows the chord is left-hand only for Snip.

**Windows: `Alt+Shift+letter`.** This is the only modifier pair that avoids Win-key reservations, AltGr, and the crowded `Ctrl+Shift` app space (Save As, reopen tab, close window, DevTools, and Discord's background `Ctrl+Shift+M/D`). The known cost is that `Left Alt+Shift` is the default input-language switch when several layouts are installed, and Glimpse's audience is likely to have several. Reports suggest the switch fires only when Alt+Shift is pressed *without* a third key. That is not verified, so it is a spike test (see the open questions below).

**macOS: `⌃⇧letter`.** macOS barely uses Control+Shift. The only system entries are Dock magnification, display sleep with the power key, and panel focus. Snagit uses this space for its global capture keys (`⌃⇧C`, `⌃⇧O`), and S/L don't collide with those. Including Control also gets past the Sequoia rule against ⌥-only hotkeys. Japanese Input uses `⌃⇧J` to switch to Hiragana, so neighbouring `⌃⇧` letters (K, L, ;) should be tested with a Japanese IME active.

**Fullscreen games.**
- *Windows:* `RegisterHotKey` is matched system-wide before the focused app sees the keystroke, which is why ShareX, Discord and similar tools work in games. What can still defeat it: a game's low-level keyboard hook, and possibly elevated or anti-cheat-protected processes (unverified). Exclusive-fullscreen D3D games may also minimise when Glimpse's overlay takes focus. That is a capture/overlay problem for the spike, not a hotkey one.
- *macOS:* this depends on the shell's implementation. **Electrobun's current `GlobalShortcut` on macOS uses `NSEvent addGlobalMonitorForEvents` (keyDown)**, not Carbon `RegisterEventHotKey` (nativeWrapper.mm L10353–L10387 @ `9c51500`). As a result it:
  - needs Accessibility trust for key events. Grants on unsigned, ad-hoc-signed builds may be lost on each update. Electrobun doesn't check `AXIsProcessTrusted`, so the hotkey silently does nothing.
  - cannot consume the keystroke, so the focused app or game also receives `⌃⇧S`.
  - doesn't fire while Glimpse itself is frontmost.
  - always "succeeds", so conflicts can't be detected.

  Tauri's `global-hotkey` crate uses `RegisterEventHotKey` on macOS and `RegisterHotKey` on Windows, and returns `AlreadyRegistered` / `FailedToRegister`. Electrobun on Windows already uses `RegisterHotKey` with `MOD_NOREPEAT`. **Recommendation for the spike:** on macOS, use Carbon hotkeys through the Rust sidecar or an upstream patch rather than the NSEvent monitor.

## Conflict matrix (shortlisted candidates)

✅ none found · ⚠️ minor or conditional · ❌ disqualifying · ? not verified

**Windows**

| Candidate | OS reserved | Screenshot/OCR/translate tools | Popular apps / overlays | Layout / IME | Games | Verdict |
|---|---|---|---|---|---|---|
| **`Alt+Shift+S`** | ✅ | ✅ (ShareX, Greenshot, Snagit use PrtScn; PowerToys uses Win+) | ✅ in Word, VS Code, Google Docs (partial check) | ⚠️ Alt+Shift language-switch interaction ? | ✅ (rare) | **Pick** |
| **`Alt+Shift+L`** | ✅ | ✅ | ⚠️ Word: Outline-view toggle only | ⚠️ same as above | ✅ | **Pick** |
| `Alt+Shift+W` / `A` / `D` | ✅ | ✅ | ⚠️ VS Code `Alt+Shift+A`, Word `Alt+Shift+D` | ⚠️ | ❌ WASD + Alt free-look | Rejected |
| `Ctrl+Shift+S` / `L` | ✅ | ? AMD Adrenalin instant replay (`Ctrl+Shift+S`, user report) | ❌ Save As everywhere; VS Code `Ctrl+Shift+L` | ⚠️ `Ctrl+Shift` can be the layout-switch key | ⚠️ crouch+sprint | Rejected |
| `Ctrl+Alt+S` / `L` | ✅ | ✅ | ⚠️ IntelliJ settings / reformat | ❌ AltGr (Polish ś, ł) | ✅ | Rejected |
| `Win+Shift+T` / any `Win+` | ❌ reserved; Win+Shift+S/R/C… taken | ❌ PowerToys Text Extractor `Win+Shift+T` | ⚠️ Game Bar `Win+G`, `Win+Alt+R/G/T/PrtScn` | ✅ | ❌ Win key often disabled in games | Rejected |
| `PrtScn` / `Ctrl+PrtScn` / `Shift+PrtScn` | ❌ PrtScn opens Snipping Tool (Win11 default) | ❌ ShareX (Ctrl+ region, Shift+ record), Greenshot, Snagit | ✅ | ✅ | ✅ | Rejected (also no key on Mac, Fn on many laptops) |
| `Alt+Q` / `Alt+letter` | ✅ | ⚠️ Translumo `Alt+Q`/`Alt+T` | ❌ menu access keys; NVIDIA `Alt+Z`, `Alt+R`, `Alt+F1` | ✅ | ⚠️ | Rejected |

**macOS**

| Candidate | OS reserved | Screenshot/OCR/translate tools | Popular apps | Layout / IME | Verdict |
|---|---|---|---|---|---|
| **`⌃⇧S`** | ✅ | ✅ (Snagit uses ⌃⇧C/⌃⇧O) | ✅ VS Code, Google Docs (partial check) | ✅ | **Pick** |
| **`⌃⇧L`** | ✅ | ✅ | ✅ (partial) | ? Japanese IME uses `⌃⇧J`; L not seen in docs | **Pick** (test with JP IME) |
| `⌘⇧S` / `⌘⇧L` | ✅ | ✅ | ❌ Save As/Duplicate; `⌘⇧L` VS Code select-all-occurrences | ✅ | Rejected |
| `⌘⇧1` / `⌘⇧2` (next to screenshot keys) | ✅ (3/4/5/6 taken) | ❌ TextSniper `⌘⇧2`; Shottr ? | ⚠️ Xcode | ✅ | Rejected |
| `⌥S`, `⌥⇧S` | ⚠️ Sequoia rejects ⌥-only modifiers | ❌ Bob/Easydict `⌥S` screenshot-translate | ✅ | ❌ types ß/Í; Polish Pro ś; JP IME `⌥⇧S` → Romaji | Rejected |
| `⌃⌥S` | ⚠️ ⌃⌥ is the VoiceOver modifier | ✅ | ✅ | ✅ | Rejected (accessibility) |
| `⌃⌘S` | ⚠️ `⌃⌘` family partly system (Q, F, Space, D) | ✅ | ? | ✅ | Reserve as fallback |
| `⌃Space`, `⌘Space`, `⌘⇧Space`, `⌥Space` | ❌ input source / Spotlight / Siri (macOS 27) | ❌ Alfred/Raycast `⌥Space` | — | ❌ | Rejected |

DeepL (`Ctrl+C+C` / `⌘C+C`) and CleanShot X (defaults not verified, believed to be `⌘⇧`-based) don't overlap with the picks.

## Rejected alternatives (summary)

- **Ctrl↔⌘ mirrored pair** (e.g. `Ctrl+Shift+S` / `⌘⇧S`): Save As on both OSes.
- **Win-key combos:** reserved by the OS, the reserved set keeps growing, and the Win key is disabled in many games.
- **Ctrl+Alt on Windows / ⌥-only on macOS:** break typing on European layouts; Sequoia registration restriction.
- **PrintScreen family:** owned by Snipping Tool and ShareX/Greenshot/Snagit, and absent on Mac keyboards.
- **A separate global "Stop Live" key:** adds a third global chord for no gain over a toggle. It remains available as an optional unbound action.
- **WASD-cluster letters (W for "watch", D for "dock"):** accidental triggers in games.

## Registration failure handling

1. **Register at startup; every failure is visible.** Windows: `RegisterHotKey` fails when another app already holds the combo (`GetLastError` → `ERROR_HOTKEY_ALREADY_REGISTERED`). macOS (Carbon): `eventHotKeyExistsErr` (−9878) only covers other Carbon registrants. It does **not** catch system shortcuts, so Glimpse should also check a hand-maintained list of macOS defaults plus the user's `com.apple.symbolichotkeys` overrides. Neither OS reports *app-local* shortcuts (e.g. Word's `Alt+Shift+L`). Users find those by trying the key.
2. **On failure:** don't silently rebind. Show a tray/menu-bar badge and one notification ("Snip shortcut Alt+Shift+S is used by another app — choose another"), and mark the action "not set" in Settings. Tray/menu-bar items for Snip and Live always work, so Glimpse stays usable with no hotkeys.
3. **First run:** a hotkeys step shows each default with live status (registered / conflict) and a shortcut recorder. When a default is taken, offer one pre-vetted alternative per OS (Windows `Alt+Shift+Y` / `Alt+Shift+U`: not in the Word/VS Code/Docs lists and away from WASD; macOS `⌃⌘S` / `⌃⌘L`) and confirm by asking the user to press it.
4. **Validate user-chosen combos** in the recorder. Block: bare keys, `Esc`, `F12` on Windows (reserved for debuggers), `Win+` combos (warn), ⌥-only/⌥⇧-only on macOS. Warn on `Ctrl+Alt+letter` (AltGr) and on WASD letters combined with Shift/Alt.
5. **macOS with Electrobun's NSEvent monitor** (if it is kept): check `AXIsProcessTrusted()` at launch. If Glimpse is not trusted, treat it as a registration failure and send the user to Accessibility settings.
6. Display keys using the current layout's labels (`UCKeyTranslate` / `MapVirtualKeyEx`) so that AZERTY/QWERTZ users see the key they actually press.

## Open questions (for the spike / owner)

1. **Alt+Shift and the input-language switch (Windows):** with two or more layouts installed, does `Alt+Shift+S` switch the layout as well as firing the hotkey? Does the Alt key-up that the foreground app sees after the Live-toggle hotkey activate its menu bar? Test with EN+JA IME and EN+PL. If either breaks, the Windows fallback family is `Ctrl+Alt+F-key` (e.g. `Ctrl+Alt+F9`/`F10`). AltGr+F-key types nothing, so this family is AltGr-safe, but it's less memorable and needs Fn on many laptops. The owner needs to accept that trade-off up front.
2. **macOS hotkey backend:** move to Carbon `RegisterEventHotKey` (sidecar or upstream PR), or accept Electrobun's Accessibility-gated, non-consuming NSEvent monitor? Strong recommendation: Carbon.
3. **Japanese/Chinese IME on macOS:** confirm that `⌃⇧L` and `⌃⇧S` don't clash with Kotoeri, Google Japanese Input or Pinyin.
4. **Elevated / anti-cheat games on Windows:** does `RegisterHotKey` still fire while they are focused? Unverified.
5. Should *re-snip last region* get a default (Greenshot/Capture2Text have one)? This proposal leaves it unbound to keep the global footprint at two keys.

## Sources

- Microsoft, RegisterHotKey (Win key reserved, F12 reserved, failure behaviour, PrintScreen override note): https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-registerhotkey
- Raymond Chen, the reserved Win-key set grows over time: https://devblogs.microsoft.com/oldnewthing/20071130-00/?p=24333
- Raymond Chen, Ctrl+Alt shortcuts steal AltGr characters: https://devblogs.microsoft.com/oldnewthing/20120423-00/?p=7803
- Elektroda (Polish AltGr+E/ę hijacked by Ctrl+Alt hotkeys): https://www.elektroda.com/rtvforum/topic3436165.html
- Microsoft, Windows keyboard shortcuts (Win+Shift+S/R, PrtScn, Ctrl+Shift layout switch): https://support.microsoft.com/en-us/windows/keyboard-shortcuts-in-windows-dcc61a57-8ff0-cffe-9796-cb9706c75eec
- PrtScn opens Snipping Tool by default in Windows 11: https://pureinfotech.com/enable-print-key-take-screenshot-snipping-tool-windows-11 , https://windowscentral.com/software-apps/windows-11/microsoft-is-changing-what-the-print-screen-key-does-on-windows-11-heres-how-to-change-it-back
- Microsoft, Disabling shortcut keys in games (WH_KEYBOARD_LL): https://msdn.microsoft.com/fi-fi/library/ee416808.aspx
- Gaming-keyboard Win lock: https://www.tomsguide.com/how-to/how-to-disable-the-windows-key
- Alt+Shift language switch vs Alt+Shift app shortcuts: https://archives.oxygenxml.com/doc/versions/25.1/ug-editor/topics/keyboard-language-gets-reset.html , https://wiert.me/2018/05/14/when-windows-suddenly-starts-mixing-up-keys-for-various-applications/ , https://forum.vivaldi.net/topic/7977/conflicting-keys
- PowerToys shortcuts (Text Extractor Win+Shift+T, etc.): https://learn.microsoft.com/windows/powertoys , https://www.webnots.com/keyboard-shortcuts-for-microsoft-powertoys-tools/
- Xbox Game Bar shortcuts: https://winaero.com/game-bar-keyboard-shortcuts-windows-10 , https://www.techradar.com/how-to/how-to-use-xbox-game-bar-in-windows-10
- NVIDIA overlay Alt+Z / Alt+F1 / Alt+R (third-party): https://www.computerhope.com/jargon/n/nvidia-overlay.htm
- AMD Ctrl+Shift+S (user report only): https://community.amd.com:443/t5/pc-drivers-software/how-to-disable-hotkeys-in-adrenalin-2020-19-12-2-driver/m-p/254672
- Discord background Ctrl/Cmd+Shift+M/D: https://discord.com/blog/how-to-use-keyboard-shortcuts-on-discord-create-custom-keybinds
- ShareX PrtScn defaults: https://nerdschalk.com/how-to-use-sharex-to-take-screenshots-and-record-screen-on-windows-11-or-10-2/
- Snagit global capture (PrtScn / ⌃⇧C, ⌃⇧O): https://www.techsmith.com/learn/tutorials/snagit/snagit-hotkeys/
- Capture2Text Win+Q default: https://www.ghacks.net/?p=133991
- Translumo Alt+Q / Alt+T (fork README): https://cdn.jsdelivr.net/gh/ramjke/translumo@master/README.md
- DeepL Ctrl+C+C: https://support.deepl.com/hc/en-us/articles/360020613059-Use-DeepL-shortcuts-for-desktop-apps
- Word shortcuts (Alt+Shift+L Outline only; no Alt+Shift+S): https://support.microsoft.com/en-us/office/keyboard-shortcuts-in-word-95ef89dd-7142-4b50-afb2-f762f663ceb2
- VS Code default keybindings: https://code.visualstudio.com/docs/reference/default-keybindings
- Google Docs shortcuts: https://support.google.com/docs/answer/179738
- Apple, Mac keyboard shortcuts (screenshots, Spotlight, input sources, ⌘⇧6 / ⌘⇧Space Siri on macOS 27): https://support.apple.com/en-us/102650
- Sequoia ⌥/⌥⇧-only hotkey restriction: https://developer.apple.com/forums/thread/763878?page=2 , https://shottr.cc/kb/sequoia
- Bob / Easydict ⌥S defaults: https://github.com/tisfeng/Easydict/blob/main/README_EN.md
- TextSniper ⌘⇧2: https://toolsandtoys.net/textsniper-for-macos/
- Apple Japanese Input (⌃⇧J Hiragana, ⌥⇧S Romaji): https://support.apple.com/guide/japanese-input-method/jpim10267/mac , https://support.apple.com/guide/japanese-input-method/jpim10263/mac
- Carbon conflict detection limits (eventHotKeyExistsErr, symbolichotkeys): https://pkg.go.dev/github.com/go-macos/hotkey
- Electrobun GlobalShortcut source (commit `9c51500`): https://github.com/blackboardsh/electrobun/blob/9c51500d132f857689bba0f0742f2836bd973d29/package/src/native/macos/nativeWrapper.mm#L10353 , …/package/src/native/win/nativeWrapper.cpp#L13823
- Tauri global-hotkey crate (commit `c0ee632`): https://github.com/tauri-apps/global-hotkey/blob/c0ee632d8dd4725f2c299cb010453590baa6ecec/src/platform_impl/macos/mod.rs#L117 ; plugin docs https://v2.tauri.app/plugin/global-shortcut/

**Not verified:** AMD's default bindings, NVIDIA defaults from first-party docs, CleanShot X and Shottr defaults, Alt+Shift layout-switch behaviour when a third key is pressed, RegisterHotKey with elevated or anti-cheat games, whether `⌃⇧L` clashes with any Japanese IME, and the full JetBrains/Office Alt+Shift keymaps (partial check only).
