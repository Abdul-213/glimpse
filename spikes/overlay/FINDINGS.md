# GLIM-13 findings: transparent full-screen region-picker overlay on Electrobun

Status: **code written, not yet run on a real desktop.** Written 2026-10-30 on headless
Linux. Manual results go in [TESTING.md](TESTING.md) section 3.

Electrobun version under test: **2.0.6-beta.2**, npm `gitHead`
[`a215432`](https://github.com/blackboardsh/electrobun/tree/a21543289f43c1fab5a6e0ebda1b072242dfc1b9).
Unless noted otherwise, every source link below points at that commit. The latest stable
release is 2.0.5 ([`d06abc9`](https://github.com/blackboardsh/electrobun/tree/d06abc9edf0b4e55116129cabbfe17bf89e11791)).
`main` was at `3c4b81a` (tag v2.0.6-beta.8, not yet on npm) when I read it. For
everything below, `main` behaves the same as beta.2.

## 1. Summary

| Capability | Electrobun public API | What the spike does | Confidence |
|---|---|---|---|
| Transparent window | **Yes** (`transparent: true`). Windows needs ≥ 2.0.6-beta.1 | Uses it | Medium (source-read only) |
| Borderless | **Yes** (`titleBarStyle: "hidden"` + `styleMask`) | Uses it | High |
| Always on top | **Partial.** macOS uses `NSFloatingWindowLevel` (3) only, which is below the Dock and menu bar. Windows `HWND_TOPMOST` is fine | macOS: FFI sets level 1000. Windows: Electrobun API | Medium |
| Above macOS menu bar / Dock | **No** | FFI shim (`setLevel:`) | Medium |
| Over macOS fullscreen apps / other Spaces | **Partial.** `setVisibleOnAllWorkspaces` adds `CanJoinAllSpaces`, but every window also has `FullScreenPrimary`, and there is no `FullScreenAuxiliary` or `NSPanel` | FFI shim fixes the collection behaviour; app runs as an accessory app | **Low**: the riskiest item |
| Window-level click-through | **No.** `passthrough` is per-webview inside a window, not for the whole window | Not needed for the picker. Gap for the Live popup | High |
| One window per display | **Yes** | One window per display | High |
| One spanning window | Not viable (section 4) | Not attempted | High |
| Display enumeration + scale | **Yes.** `Screen.getAllDisplays()`: logical bounds, workArea, scaleFactor, isPrimary | Uses it. Adds physical bounds via FFI on Windows | High |
| Physical-pixel monitor rects | **No** (logical only) | Windows: `GetMonitorInfoW(Display.id)` via FFI | High |
| Display-change events | **No** | Re-reads displays on every open | High |
| Hide from taskbar / Alt+Tab | **No** (windows get `WS_EX_APPWINDOW`) | Windows: FFI sets `WS_EX_TOOLWINDOW` | Medium |
| Cursor position / mouse buttons | **Yes** (`Screen.getCursorScreenPoint`, `getMouseButtons`) | Fallback polling for cross-display drags | High |
| Capture exclusion (`WDA_EXCLUDEFROMCAPTURE`, `NSWindowSharingNone`) | **No.** No `SetWindowDisplayAffinity` / `setSharingType` anywhere in the native code | Out of scope here; the same FFI route would work | — |
| FFI escape hatch | **Yes.** `BrowserWindow.ptr` is the `NSWindow*` / `HWND`, and `bun:ffi` can `dlopen` system libraries | Used for all shims | High |

**Expectation**

- **Windows: pass, possibly partial.** The core picker should work. The risks are
  keyboard focus after a delayed or timer-driven open (Esc), and exclusive-fullscreen
  games, which no window-based overlay can cover.
- **macOS: partial.** Covering the menu bar and Dock should work through the FFI shim.
  Covering another app's fullscreen Space is the uncertain part. Without the shim I
  expect a **fail** on both.

Details are in section 6.

## 2. Transparent windows

- **API:** `transparent: boolean` in `WindowOptionsType`
  ([BrowserWindow.ts#L45](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/sdks/main/core/BrowserWindow.ts#L45)).
  The core passes the window's flag through to its webview.
- **macOS:** sets `backgroundColor = clearColor`, `opaque = NO`, `hasShadow = NO` and a
  clear content layer
  ([nativeWrapper.mm#L9590](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L9590)).
  The window's WKWebView gets `drawsBackground = NO`
  ([#L3060](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L3060)).
  This looks complete.
- **Windows:** in **2.0.5 stable** a transparent window is created with
  `WS_EX_LAYERED` and never calls `SetLayeredWindowAttributes` or
  `UpdateLayeredWindow` for WebView2
  ([2.0.5 nativeWrapper.cpp#L11381](https://github.com/blackboardsh/electrobun/blob/d06abc9edf0b4e55116129cabbfe17bf89e11791/package/src/native/win/nativeWrapper.cpp#L11381)).
  Commit [`d072fc1e5`](https://github.com/blackboardsh/electrobun/commit/d072fc1e5eb72eaa36854be80320fc558c02a73f)
  (2026-10-28, "ui-core: transparent windows on Windows") replaced it with
  `WS_EX_NOREDIRECTIONBITMAP`. Its message says "a layered window hides composition
  content, and a redirected one puts an opaque surface behind it. Checked with
  transparent WebView2 and CEF windows." The fix is in beta.2
  ([nativeWrapper.cpp#L13064](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L13064)),
  and WebView2 gets `DefaultBackgroundColor = {0,0,0,0}`
  ([#L7600](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L7600)).
  **That is why the spike pins 2.0.6-beta.2.** I expect 2.0.5 to show an invisible or
  empty overlay on Windows, but I haven't checked that.
- The background colour is set after the WebView2 controller is created
  asynchronously, so a one-frame opaque flash on open is possible (TESTING #1).

## 3. Always-on-top, menu bar, Dock, fullscreen apps, Spaces

### What Electrobun does on macOS

- `setAlwaysOnTop(true)` → `[window setLevel:NSFloatingWindowLevel]`
  ([nativeWrapper.mm#L9751](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L9751)).
  Level 3 is below the Dock (20) and the main menu (24), so **the menu bar and Dock
  stay above the overlay**. There is no level parameter.
- Every window is created with `NSWindowCollectionBehaviorFullScreenPrimary`
  ([#L9506](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L9506)).
  That's right for document windows, but it can't be combined with
  `FullScreenAuxiliary`, which an overlay needs.
- `setVisibleOnAllWorkspaces(true)` only ORs in `CanJoinAllSpaces`
  ([#L11621](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L11621)).
  There's no `FullScreenAuxiliary`, `Stationary` or `IgnoresCycle`.
- Windows are `ElectrobunWindow : NSWindow` with `canBecomeKeyWindow = YES`
  ([#L9477](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L9477)).
  That's good: a borderless window can take keyboard input for Esc. It is **not** an
  `NSPanel`, so the `NonactivatingPanel` style bit in the styleMask API does nothing.
- `Utils.setDockIconVisible(false)` switches to
  `NSApplicationActivationPolicyAccessory`
  ([#L10434](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L10434)).
  The build config has no `LSUIElement` / Info.plist override, so the Dock icon
  appears briefly at launch.
- `showWindow(activate)` calls `makeKeyAndOrderFront` +
  `activateIgnoringOtherApps:YES`
  ([#L9613](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L9613)).

### What the spike adds on macOS

`src/bun/native-mac.ts` does all of this without any native code of our own:

- Electrobun runs app JS on a **worker thread**, and the core owns the main thread
  ([docs: Main-thread model](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/docs/src/content/docs/electrobun/guides/architecture/overview.mdx#L68)).
  AppKit setters must run on the main thread. The shim builds an `NSDictionary` and
  calls `[window performSelectorOnMainThread:@selector(setValuesForKeysWithDictionary:) withObject:dict waitUntilDone:NO]`
  through `objc_msgSend` from `bun:ffi`. KVC unboxes the NSNumbers into `setLevel:`,
  `setCollectionBehavior:`, `setHasShadow:` and so on.
- It sets level **1000** (`NSScreenSaverWindowLevel`, configurable) and collection
  behaviour `(current & ~(FullScreenPrimary|MoveToActiveSpace|Managed)) | CanJoinAllSpaces | Stationary | IgnoresCycle | FullScreenAuxiliary`.
  It also sets `acceptsMouseMovedEvents = YES`, `movable = NO` and
  `hidesOnDeactivate = NO`.
- It runs the app as an accessory app.

### Open risks on macOS

Only real hardware can settle these.

1. **Fullscreen Spaces.** An accessory app's `NSWindow` with
   `CanJoinAllSpaces|FullScreenAuxiliary` at a high level *usually* appears over
   another app's fullscreen Space. The most reliable recipe (Spotlight-style
   launchers, CleanShot) is a **non-activating `NSPanel`**. If TESTING #18 fails, that
   needs native code. One option is an upstream Electrobun patch (e.g. a
   `windowClass: "panel"` option). The other is our own small dylib: an `NSPanel`
   subclass with `NSWindowStyleMaskNonactivatingPanel`, loaded with `bun:ffi`
   `dlopen`. The dylib route means compiling and ad-hoc signing Objective-C, which
   this spike avoided. Changing Electrobun's existing window into an `NSPanel` after
   creation would need `object_setClass` hacks.
2. `waitUntilDone:NO` applies our properties asynchronously, so they can race
   `showWindow`. Run-loop ordering makes it very likely they land first, but the
   `window` log record reads level and collectionBehavior back after 400 ms to
   confirm.
3. Hover in non-key windows. WebKit may not deliver mouse-moved events to a non-key
   overlay (e.g. the crosshair on the second display). The Bun side polls
   `Screen.getCursorScreenPoint()` to drive the crosshair when no view events arrive.
4. The first click on a non-key overlay may only activate it (`acceptsFirstMouse`).
   That would show up as needing two clicks on the second display.

### Windows

- `setAlwaysOnTop` → `SetWindowPos(HWND_TOPMOST)` on the UI thread
  ([nativeWrapper.cpp#L13452](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L13452)).
  That's sufficient.
- `setVisibleOnAllWorkspaces` is a no-op that only records a flag
  ([#L13479](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L13479)).
- `titleBarStyle: "hidden"` gives `WS_POPUP`
  ([#L13045](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L13045)),
  but always with `WS_EX_APPWINDOW`
  ([#L13038](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L13038)).
  The shim swaps that for `WS_EX_TOOLWINDOW` with `SetWindowLongPtrW`.
- Exclusive-fullscreen D3D games can't be covered by any normal window. Glimpse would
  need the game in borderless mode, or a different strategy (capture first, then show
  a screenshot-backed picker). That's a product note, not an Electrobun gap.

## 4. One window per display vs one spanning window

**One window per display** is the only workable design on both OSes:

- **macOS:** with "Displays have separate Spaces" (the default), a window shows on
  one display only, and an `NSWindow` has a single `backingScaleFactor`.
- **Windows:** a window has one DPI. WebView2 rasterises at that DPI, so the part on
  a monitor with a different scale gets scaled by DWM and looks blurry. Electrobun
  also converts a frame to physical pixels using **only the monitor at its top-left
  point** (`windowsMonitorForLogicalPoint` + `logicalToPhysicalScreenRect`,
  [windows_dpi.h#L493](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/shared/windows_dpi.h#L493)),
  so a frame spanning mixed-DPI monitors would get the wrong size.

### How the spike handles it

- It creates one borderless transparent window per display, with
  `frame = display.bounds`.
- The Bun process owns the picker state and broadcasts the global selection to every
  view. Each view draws its own intersection.
- A drag that crosses displays keeps working in three ways:
  1. The origin view holds pointer capture.
  2. Points outside the origin display are replaced with
     `Screen.getCursorScreenPoint()`. Extrapolating local CSS px is wrong across
     mixed DPI on Windows.
  3. If no view event arrives for 120 ms, `Screen.getMouseButtons()` detects the
     release.
- The `stats` field in each result shows which of these paths fired.

## 5. Displays, scale factors and coordinates

`Screen.getAllDisplays()`
([proc/native.ts#L3136](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/sdks/main/proc/native.ts#L3136))
returns `{id, bounds, workArea, scaleFactor, isPrimary}` in **global logical,
top-left-origin** coordinates.

### macOS

- Source: `getAllDisplays`
  ([#L10999](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L10999)).
- Units are points, flipped against `screens[0]` (the menu-bar screen).
  `scaleFactor = backingScaleFactor` and `id = CGDirectDisplayID`. Values are cast to
  `int`.
- macOS has no global pixel space, so "physical" is reported per display (local
  points × scale).
- The spike also logs CoreGraphics mode sizes. In "More Space" scaled modes the
  backing store (`scaleFactor` × points) differs from the panel's native pixels,
  which matters for the capture spike.

### Windows

- Source: `getAllDisplays`
  ([#L15755](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L15755)).
- The process is per-monitor-v2 DPI aware
  ([configurePerMonitorDpiAwareness #L568](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L568)).
- Bounds are **DIPs in a Chromium-style layout**
  ([layoutWindowsLogicalMonitors windows_dpi.h#L317](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/shared/windows_dpi.h#L317)).
  The primary is rooted at its physical origin ÷ scale. Every other monitor is sized
  physical ÷ its own scale, and touching edges are preserved.
- Example: a 100 % monitor to the right of a 4K 150 % primary sits at logical
  x = 2560 but physical x = 3840.
- **Physical rects are not exposed.** `Display.id` is the `HMONITOR` value
  ([serializeWindowsDisplay #L15726](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L15726)),
  so the spike calls `GetMonitorInfoW(id)` / `GetDpiForMonitor` through `bun:ffi`.
  That relies on an implementation detail, not a documented contract.

### Both OSes

- Window frames use the same logical space, so `frame = display.bounds` maps exactly
  onto the monitor on both OSes when the window is created.

### macOS Y-flip bug

- `setWindowFrame`, `setWindowPosition` and `getWindowFrame` flip Y against the
  window's *current* screen height instead of the primary screen's
  ([#L9864](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L9864),
  [#L9878](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L9878),
  [#L9767](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L9767)).
- Creation flips correctly against `screens[0]`
  ([#L9485](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L9485)).
- So moving or reading a window on a secondary display whose height differs from the
  primary gives the wrong Y.
- The spike never moves windows. It logs `getFrame()`, so on mixed setups I expect
  `window.electrobunGetFrame.y` ≠ `requestedFrame.y`.
- It matters for the Live popup, which has to be positioned next to the selection.
  Worth an upstream issue.

### What the spike reports on release

The `selection` record contains:

- the global logical rect, snapped to the device-pixel grid of the display at its
  top-left;
- for each display it touches: the local logical rect, local physical rect, scale
  and, on Windows, the global physical rect.

When the selection spans mixed scales there is no single faithful physical rect, so
captures must be done per piece (`spansMixedScale`). On Windows a `cursorCheck`
compares the predicted physical coordinates with `GetCursorPos`.

## 6. Expected outcome per OS

### Windows: pass, possibly partial

Transparency (beta.2), topmost, PMv2 DPI handling, a monitor-exact frame and display
enumeration are all in Electrobun. Physical rects and taskbar hiding need only small,
read-mostly Win32 FFI.

Risks:

1. **Focus.** `SetForegroundWindow` is refused when the open isn't tied to user input
   (timer or delayed open). Electrobun falls back to `AttachThreadInput` and then
   `FlashWindowEx`, so Esc may need a click first (TESTING #7, #23).
2. A transparent-window flash on open.
3. Exclusive-fullscreen games. Any window-based approach fails there.
4. Cross-monitor drags may depend on polling.

### macOS: partial

Transparency, borderless windows, key-window input and display data are fine. The
problems:

- Covering the menu bar and Dock, and joining fullscreen Spaces, are **not possible
  through Electrobun's API**. They rely on the KVC/`performSelectorOnMainThread` FFI
  shim, which is untested.
- Covering another app's fullscreen Space may still need a non-activating `NSPanel`,
  i.e. real native code.
- The `getWindowFrame` Y bug affects multi-display setups.

Without the shim (tray item "Electrobun only, no native shims") I expect a **fail** on
menu bar, Dock and fullscreen coverage.

## 7. What was verified here vs not

### Verified on headless Linux (x64)

- Installed Bun 1.4.4 into `~/.bun/bin` and Hutch 0.28.2 into `~/.hutch`. The Hutch
  installer also appended its PATH line to `~/.bashrc`.
- `hutch install` and `hutch electrobun sync` with Electrobun 2.0.6-beta.2 succeed.
- `tsc --noEmit` passes against the Electrobun devkit types, for the main process,
  the views and the FFI shims.
- `bun test`: **21 tests pass**, covering the coordinate maths and the picker state
  machine.
  - Fixtures: Retina + 1x with a vertical offset; Windows 150 % + 100 % in the
    Chromium-style layout; 125 % with a monitor at negative x.
  - Cases: seam-spanning splits, device-pixel snapping and keyboard adjust.
- `hutch electrobun build --env=dev` produces a Linux bundle that includes the view
  bundle and both shims.
- Read the Electrobun source and docs at the commits above.

### Not verified

- **Nothing has been run with a display.** Launching here stops at missing
  GTK/WebKitGTK libraries (no sudo, no X server). The app targets Windows and macOS
  anyway.
- The FFI shims have never executed. That covers the objc_msgSend signatures, the KVC
  keys, `performSelectorOnMainThread` called from Electrobun's worker, and the Win32
  struct layouts.
- No Windows or macOS build was produced, because Hutch builds only for the host OS.
- No CI workflow was added. GitHub only reads workflows from `.github/workflows/` at
  the repo root, and this spike must stay under `spikes/overlay/`. If you want one,
  add a `workflow_dispatch`-only workflow that runs
  `hutch run install && hutch electrobun build --env=dev` in this directory on
  `windows-latest` and `macos-latest`.
- WebView2 / WKWebView pointer-capture behaviour across windows, RPC latency, and
  first-paint flashes.

## 8. Gaps to raise upstream (or work around in the real app)

1. **Window level and Spaces options.** A level API (or an `"overlay"` /
   `"screen-saver"` preset), plus `FullScreenAuxiliary`, `Stationary` and
   `IgnoresCycle` options. Electrobun should also stop forcing `FullScreenPrimary` on
   borderless windows.
2. **A non-activating panel window class on macOS.** Overlays need it, and so do
   popups that must not steal focus from a fullscreen game ("Never in the way").
3. **Window-level click-through** (`setIgnoresMouseEvents:` / `WS_EX_TRANSPARENT`).
   This matters for the Live popup, not the picker.
   - On Windows, `WS_EX_TRANSPARENT` only works together with `WS_EX_LAYERED`, which
     Electrobun just stopped using for transparent windows because it hides
     composition content.
   - Per-region hit-testing needs a `WM_NCHITTEST` subclass. A Win32 window procedure
     must run synchronously on the UI thread, and `bun:ffi` `JSCallback`s run on the
     JS worker. So this needs a small native DLL or an upstream option.
4. **Physical monitor rects** in `Display`, and display-change events.
5. **Capture exclusion** (`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`,
   `NSWindow.sharingType = NSWindowSharingNone`). Neither exists in the native code.
   The FFI route used here should work (on macOS via KVC `sharingType`), but that's
   the capture-exclusion spike's job.
6. **The macOS `setWindowFrame` / `getWindowFrame` / `setWindowPosition` Y-flip bug**
   (section 5).
7. **`ptr` is unsupported.** Electrobun documents it as an "advanced FFI escape
   hatch"
   ([docs](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/docs/src/content/docs/electrobun/apis/browser-window.mdx#L328)).
   It works without building native code, but all AppKit mutation has to be
   marshalled to the main thread by hand.

## 9. Files

- `src/bun/index.ts`: main process. Tray, overlay sessions, picker wiring,
  diagnostics and result logging.
- `src/bun/native-mac.ts`: objc-runtime / CoreGraphics FFI.
- `src/bun/native-win.ts`: user32 / shcore FFI.
- `src/overlay/*`: overlay webview (canvas dim, hole, crosshair, size label, edge
  frame, banner).
- `src/shared/geometry.ts`, `src/shared/picker.ts`: pure logic, unit-tested in
  `test/`.
- `src/shared/rpc.ts`: typed RPC schema.
