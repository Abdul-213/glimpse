# GLIM-19 findings: native window materials and frameless popups on Electrobun

Status: **code written, unit-tested and bundled on headless Linux; never run with a
display.** Written 2026-10-30. Manual results go in [TESTING.md](TESTING.md) section 3.

Electrobun version: **2.0.6-beta.2** (npm `gitHead`
[`a215432`](https://github.com/blackboardsh/electrobun/tree/a21543289f43c1fab5a6e0ebda1b072242dfc1b9)),
pinned for the Windows transparency fix found by GLIM-13 (commit `d072fc1e5`: transparent
windows use `WS_EX_NOREDIRECTIONBITMAP` instead of `WS_EX_LAYERED`). Every source link below
points at that commit. `EB` is short for Electrobun.

## 1. Summary

| Need | Electrobun public API | What the spike does | Confidence |
|---|---|---|---|
| Transparent, frameless window | **Yes** (`transparent: true`, `titleBarStyle`) | Uses it | High on macOS, medium on Windows (needs beta.2) |
| Native material (vibrancy / Mica / Acrylic) | **No.** There is no material, vibrancy or backdrop API anywhere in the native code | macOS: own dylib inserts `NSVisualEffectView`. Windows: `DwmSetWindowAttribute` from `bun:ffi` | Medium |
| Rounded window corners | **No** | macOS: effect-view `maskImage`. Windows 11: `DWMWA_WINDOW_CORNER_PREFERENCE` | Medium-high |
| Native shadow on a transparent window | **No.** macOS: EB sets `hasShadow = NO` for transparent windows. Windows: only `hiddenInset` keeps a DWM frame | macOS: dylib sets `hasShadow = YES`. Windows: `hiddenInset` + `DwmExtendFrameIntoClientArea(-1)` | Medium |
| Show without activating | **Partial.** `showInactive()` = `orderFrontRegardless` (macOS) / `SW_SHOWNOACTIVATE` (Windows) | Uses it, plus FFI variants | High for the show itself |
| Click without activating | **No.** EB windows are `NSWindow` (not `NSPanel`), and on Windows they get `WS_EX_APPWINDOW` | macOS: re-class to a non-activating `NSPanel` subclass. Windows: `WS_EX_NOACTIVATE` | **Low**: both are hacks or have known WebView2 caveats |
| Reduce transparency | **No** | macOS: `NSWorkspace` query (polled). Windows: `EnableTransparency` registry value (polled) | High |
| Light/dark of the native surface | **Partial.** Windows: EB sets `DWMWA_USE_IMMERSIVE_DARK_MODE` from the registry and on `WM_SETTINGCHANGE`. macOS: windows follow the system | Adds a forced light/dark mode, and polls | High |
| Settings change notifications | **No** (no `WM_SETTINGCHANGE` / `NSWorkspace` notification to JS) | Polls once a second | High |
| `underPageBackgroundColor` | **No** (only `drawsBackground = NO`) | dylib sets it to clear | High |
| Escape hatch | **Yes.** `BrowserWindow.ptr` is the `NSWindow*` / `HWND` | Used for everything | High |

**Expected outcome** (details in section 7):

- **macOS: pass, possibly partial.** The material, corners, shadow and appearance use
  standard AppKit, and `NSVisualEffectView` handles reduce transparency by itself. The
  risky parts are the `NSPanel` re-class (focus on click) and a possible flash on the
  first show.
- **Windows 11 (22H2+): partial.** The DWM calls are documented and simple. The risk is
  the combination of a system backdrop, `WS_EX_NOREDIRECTIONBITMAP` and a windowed,
  transparent WebView2, which nobody has shown working in Electrobun. Clicking a WebView2
  inside a `WS_EX_NOACTIVATE` window may still take focus.
- **Windows 10: pass for the solid fallback** (by design: no material, square corners).
  The undocumented accent acrylic is expected to be **partial / fail** and shouldn't ship.

Without our native code (Electrobun's API only), both OSes **fail** the material, corner
and shadow checks: you get a transparent, square, shadowless window.

## 2. macOS approach

All of this is in `native/macos/glimmaterial.m`, a ~500-line Objective-C dylib loaded with
`bun:ffi`. It uses the same pattern as the GLIM-14 and GLIM-16 helpers: every function
hops to the main thread with `dispatch_sync`, because Electrobun runs app JS on a worker
([docs](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/docs/src/content/docs/electrobun/guides/architecture/overview.mdx#L68)).

### What Electrobun already gives us

- `transparent: true` sets `opaque = NO`, `backgroundColor = clearColor`, a clear content
  layer and **`hasShadow = NO`**
  ([nativeWrapper.mm#L9590](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L9590)).
- The WKWebView gets `drawsBackground = NO` and a clear, non-opaque layer
  ([#L3060](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L3060)).
  So the answer to "does WKWebView need `drawsBackground = NO`?" is **yes, and Electrobun
  already does it.** It does **not** clear `underPageBackgroundColor` (shown on
  rubber-band overscroll); the dylib does.
- The content view is Electrobun's `ContainerView`, and the webview is its subview
  ([#L9537](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L9537),
  [#L3172](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L3172)).
  `ContainerView` tracks webviews in its own `abstractViews` array, not through
  `subviews`, and only uses it for mouse-over routing
  ([#L1832](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L1832)).
  So a sibling view inserted *below* the webview doesn't disturb it.
- `showInactive()` → `orderFrontRegardless` (no activation); `show()` →
  `makeKeyAndOrderFront` + `activateIgnoringOtherApps:YES`
  ([#L9613](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L9613)).

### What the dylib adds

1. **Material:** an `NSVisualEffectView` with `blendingMode = .behindWindow`,
   `state = .active` (popups are usually not key, so it mustn't follow the window's active
   state), material `.popover` by default. It is added as the **bottom** subview of the
   content view with width/height autoresizing. The control window can switch to
   `hudWindow`, `menu`, `sidebar`, `windowBackground`, `underWindowBackground` or `sheet`.
2. **Corners:** the effect view's `maskImage` is a stretchable rounded rect (`capInsets` =
   radius). This is Apple's documented way to round a behind-window effect view: the
   window server clips the backdrop to it, and the window shadow follows the resulting
   alpha. The webview paints the 90 % veil with the same 12 px `border-radius`, so the
   corners are transparent in both layers. The alternative (`layer.cornerRadius` +
   `masksToBounds` on the content view) is offered for A/B, because with behind-window
   blending a layer mask may leave the blur itself square.
3. **Shadow:** `hasShadow = YES` (undoing Electrobun's `NO`), plus `invalidateShadow` after
   every material or size change and on show, because the shadow is computed from the
   window's alpha.
4. **Non-activating panel:** Electrobun's `ElectrobunWindow : NSWindow`
   ([#L9473](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L9473))
   ignores `NSWindowStyleMaskNonactivatingPanel`, which only works on `NSPanel`.
   The `styleMask.NonactivatingPanel` option in Electrobun's TS API
   ([#L711](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/macos/nativeWrapper.mm#L711))
   is therefore a no-op. The dylib re-classes the instance with `object_setClass` to
   `GlimPanel : NSPanel`, only if the instance sizes match and the object isn't
   KVO-swizzled. It then sets the non-activating style bit, `becomesKeyOnlyIfNeeded`,
   `floatingPanel`, `hidesOnDeactivate = NO` and, best effort, the private
   `_setPreventsActivation:`. This is the trick `electron-panel-window` and
   `tauri-nspanel` use. It works for them but is unsupported; `GLIM_MAC_PANEL=0` turns it
   off for A/B.
5. **Spaces / level:** strips `FullScreenPrimary` (Electrobun adds it to every window),
   adds `CanJoinAllSpaces | FullScreenAuxiliary | IgnoresCycle`, and sets level 101
   (pop-up menu).
6. **Appearance:** `window.appearance = aqua / darkAqua / nil`. The effect view and the
   WKWebView (`prefers-color-scheme`) both follow it, so one native call switches the
   material tint and the CSS together.
7. **Timing:** `show` records a `CLOCK_UPTIME_RAW` timestamp and observes
   `NSWindowDidChangeOcclusionStateNotification` to get a native "window became visible"
   time, alongside the webview's two-`requestAnimationFrame` round trip.

### Reduce transparency and appearance on macOS

- `NSVisualEffectView` turns itself opaque when "Reduce transparency" is on; that's
  AppKit's own behaviour. The spike also hides the effect view and switches the veil to
  `surface-popup-solid`, as DESIGN.md asks.
- There's no notification path from AppKit to the JS worker without our own callback
  plumbing, so `accessibilityDisplayShouldReduceTransparency` and the app's effective
  appearance are **polled every second**. A real app should observe
  `NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification` in native code and post to
  JS.
- WebKit doesn't implement `prefers-reduced-transparency` (as of Safari 18 it is unknown,
  so the popup reports `null`). The shell must drive it.

### macOS 26 "Liquid Glass"

- `NSGlassEffectView` (AppKit, macOS 26+) is the new glass material. It is looked up with
  `NSClassFromString`, so the dylib builds against older SDKs and the option shows
  "unavailable" on macOS ≤ 15. Its `cornerRadius` is set with KVC.
- **Recommendation:** don't adopt it yet. DESIGN.md's popup is a 90 %-opaque veil over the
  material, which hides most of what makes glass different (refraction, specular edge).
  It only exists on 26+, so `NSVisualEffectView` is still required for 14–15. Apple's
  guidance reserves Liquid Glass for controls and navigation layers rather than content
  surfaces. Revisit if the design moves to a lighter veil, or if `.popover` stops looking
  native on macOS 26. Use the `glass` option on a macOS 26 machine to answer DESIGN.md
  open question 11 (whether 12 px still looks concentric).

## 3. Windows approach

All of this is in `src/bun/win.ts`, plain `bun:ffi` into `dwmapi`, `user32`, `advapi32`,
`ntdll` and `kernel32`. No native code.

### Window chrome: why `titleBarStyle: "hiddenInset"`

- `"hidden"` creates a bare `WS_POPUP`
  ([nativeWrapper.cpp#L13045](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L13045)).
  With no frame, DWM gives it no shadow, and system backdrops are drawn as part of the
  frame, so on a bare popup they are unreliable. This is the same issue Tauri users hit
  with `decorations: false` + Mica.
- `"hiddenInset"` creates `WS_CAPTION | WS_THICKFRAME` and removes the caption in
  `WM_NCCALCSIZE`
  ([#L13047](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L13047),
  [#L5918](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L5918)).
  That is the standard "custom frame" recipe: you keep the DWM shadow, rounded corners and
  backdrop. The spike uses it (`GLIM_WIN_CHROME=hidden` for A/B).
- Side effect: `WS_THICKFRAME` makes the popup resizable by dragging its edges, and
  Win+arrow snapping applies. Fixing that needs a `WM_NCHITTEST` handler. A window
  procedure has to run on the UI thread, and `bun:ffi` callbacks run on the worker, so that
  needs native code or an upstream option.

### What the spike sets

1. **Transparency:** `transparent: true` (beta.2: `WS_EX_NOREDIRECTIONBITMAP`,
   [#L13064](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L13064)).
   WebView2 gets `DefaultBackgroundColor = {0,0,0,0}`, but only after the controller is
   created asynchronously
   ([#L7600](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L7600)).
   To avoid a white first frame, the spike also sets the documented
   `WEBVIEW2_DEFAULT_BACKGROUND_COLOR=0` environment variable through
   `SetEnvironmentVariableW` before the first window is created.
2. **Glass sheet:** `DwmExtendFrameIntoClientArea(hwnd, {-1,-1,-1,-1})`, so the backdrop
   shows wherever the webview is transparent.
3. **Material:** `DWMWA_SYSTEMBACKDROP_TYPE` (38) = `DWMSBT_TRANSIENTWINDOW` (Acrylic,
   DESIGN.md's popup material), or `MAINWINDOW` (Mica), `TABBEDWINDOW`, `AUTO`. This needs
   Windows 11 22H2 (22621+). On 22000 only the undocumented `DWMWA_MICA_EFFECT` (1029)
   exists, so Mica works there and Acrylic falls back to solid.
4. **Corners:** `DWMWA_WINDOW_CORNER_PREFERENCE` (33) = `DWMWCP_ROUND` (8 px, which
   matches `rounded.popup-win`). The webview uses the same 8 px.
5. **Border:** `DWMWA_BORDER_COLOR` (34) = `DWMWA_COLOR_NONE`, because DESIGN.md has the
   webview draw a 1 px hairline. There's an A/B option.
6. **Dark mode:** `DWMWA_USE_IMMERSIVE_DARK_MODE` (20) follows the effective appearance,
   which switches Acrylic/Mica between their light and dark tints. Electrobun already sets
   it from the registry on create and on `WM_SETTINGCHANGE`
   ([#L5709](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L5709)),
   which could override a forced theme. That's harmless for a follow-the-system app.
7. **No activation:** the extended style swaps `WS_EX_APPWINDOW` for
   `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE` (out of the taskbar and Alt+Tab, not activated by
   clicks). Topmost through Electrobun's `setAlwaysOnTop`. Show with `showInactive()`
   (`SW_SHOWNOACTIVATE` + `SWP_NOACTIVATE`,
   [#L13180](https://github.com/blackboardsh/electrobun/blob/a21543289f43c1fab5a6e0ebda1b072242dfc1b9/package/src/native/win/nativeWrapper.cpp#L13180)).
   Known caveat: WebView2 hosts its content in a child HWND owned by the browser process.
   Clicking it can call `SetFocus` and activate the top-level window despite
   `WS_EX_NOACTIVATE` (TESTING #8 checks this).
8. **Show/hide alternatives for latency and flashes:** `ShowWindow` directly from Bun, and
   **DWM cloaking** (`DWMWA_CLOAK`). With cloaking the window stays shown from Chromium's
   point of view, so it keeps a current frame and isn't occlusion-throttled. Un-cloaking
   should be the fastest, flash-free "show". `DwmFlush()` after the show gives a
   "next composition" timestamp.
9. **Settings:** `HKCU\...\Themes\Personalize\EnableTransparency` (transparency effects)
   and `AppsUseLightTheme`, read with `RegGetValueW` and polled every second (no
   `WM_SETTINGCHANGE` without a window procedure). Note that `HKEY_CURRENT_USER` has to be
   passed sign-extended (`0xFFFFFFFF80000001`) through FFI. When transparency effects are
   off the spike drops the backdrop and paints `surface-popup-solid`. Windows would draw a
   solid backdrop by itself anyway. Battery Saver also disables Acrylic; the app can't
   detect that through this path.

### Threading

`DwmSetWindowAttribute` and `DwmExtendFrameIntoClientArea` talk to DWM, not the window
procedure, so calling them from Bun's worker thread should be fine. `SetWindowLongPtrW`
on a same-process window from another thread is legal, and `SetWindowPos` uses
`SWP_ASYNCWINDOWPOS`. `ShowWindow` from the worker sends a message to the UI thread and
waits. That's fine unless the UI thread is blocked on the worker. The default show path
uses Electrobun's own `showInactive()`, which dispatches correctly.

### Windows 10

- No documented material or corner API. The spike detects the build with `RtlGetVersion`
  (< 22000) and uses the solid surface with **square corners**: radius 0, because the DWM
  frame and shadow are square, and a rounded webview inside a square shadow looks broken.
- `SetWindowCompositionAttribute(WCA_ACCENT_POLICY, ACCENT_ENABLE_ACRYLICBLURBEHIND)` is
  available as `accent-acrylic` / `accent-blur` for comparison. It is undocumented. It is
  known to make window moves and resizes laggy on 1903+ (the issue `window-vibrancy`
  documents for its Windows 10 acrylic). Its behaviour has changed between builds. It
  ignores "transparency effects" and can't be rounded. **Don't ship it.** The DESIGN.md
  fallback (solid surface) is the right answer.

## 4. Show/hide latency and flashes

- The popup is created at launch with `hidden: true` and configured once its webview says
  hello. Show is then a native window-order call (no page load, no layout). I expect
  well under 100 ms on both OSes. The `call` time should be ≤ 5 ms, and the web frame round
  trip roughly 1–3 frames (17–50 ms at 60 Hz).
- Measurements, all in the log:
  - `callMs`: the native show call.
  - `dwmFlushMs` (Windows): the next DWM composition after the show.
  - `macNative.visibleUs`: AppKit's occlusion "visible" notification.
  - `webFrameMs`: Bun → webview `shown` → two `requestAnimationFrame` → Bun. That's an
    upper bound including one RPC round trip.
  - The latency test runs 20 hide/show cycles per show method and reports
    min/p50/p95/max.
- Flash risks:
  1. **First show on Windows** before `DefaultBackgroundColor` is applied (mitigated by the
     env var).
  2. **Stale content:** a hidden WebView2 / WKWebView may not repaint while hidden, so the
     first frame after show can show the *previous* content. TESTING #6 checks this with
     "Show with new content". If it happens, Glimpse should update the content, wait for
     a frame, then show; or use cloaking / `alphaValue` so the view keeps rendering while
     invisible.
  3. **Material before content:** the material is native and appears immediately, so a
     few ms of empty material before the webview's veil appears is possible. That would be
     visible as a frame with the material but no veil or text.

## 5. Electrobun gaps (to raise upstream or work around)

1. **No material API.** Electron has `vibrancy` / `backgroundMaterial`, and Tauri has
   `windowEffects`. Electrobun needs something like
   `material: { mac: "popover", win: "acrylic", state: "active", radius }`.
2. **No window corner radius** or corner preference.
3. **`transparent: true` forces `hasShadow = NO` on macOS.** There is no option to keep the
   shadow.
4. **No panel window type on macOS** (`NonactivatingPanel` in `styleMask` is silently
   ignored because the window isn't an `NSPanel`). Same gap as GLIM-13's overlay. A
   `windowType: "panel"` option (as Electron has with `type: 'panel'`) would remove our
   `object_setClass` hack.
5. **No "focusable: false" / `WS_EX_NOACTIVATE` / tool-window option on Windows.**
   Windows always get `WS_EX_APPWINDOW`.
6. **`hiddenInset` on Windows is resizable** (`WS_THICKFRAME`) and there's no hit-test
   hook to stop it. A "frameless but with DWM frame, not resizable" chrome style is
   needed.
7. **No system-settings events:** appearance, reduce transparency / transparency
   effects, accent colour (DESIGN.md also wants `--os-accent` injected). Electrobun handles
   `WM_SETTINGCHANGE` internally for dark mode but doesn't forward it.
8. **`underPageBackgroundColor` isn't cleared**, and WebView2's transparent background is
   set only after the controller exists.
9. **Native-pointer escape hatch only.** Everything here works through `BrowserWindow.ptr`,
   which Electrobun documents as an advanced, unsupported FFI escape hatch. macOS needs a
   compiled, ad-hoc-signed dylib for main-thread AppKit work. That's the same conclusion
   GLIM-14 and GLIM-16 reached.
10. The macOS `setWindowFrame` Y-flip bug on secondary displays (from GLIM-13) also
    affects popup placement. The spike moves the popup with its own Cocoa-coordinate
    call.

## 6. Comparison with Tauri's `window-vibrancy`

| | Electrobun + this spike | Tauri v2 (`window-vibrancy`, built-in `windowEffects`) |
|---|---|---|
| macOS material | Own dylib: `NSVisualEffectView` below the WKWebView | `apply_vibrancy(window, material, state, radius)`: also inserts an `NSVisualEffectView` below the webview. Exposed as `windowEffects` in `tauri.conf.json` |
| macOS corners | `maskImage` (stretchable) | `radius` param (sets the effect view's layer corner radius). Same idea; Tauri apps also commonly add a mask |
| macOS transparency | Built in (`transparent: true`) | `transparent: true` needs `macOSPrivateApi: true` (uses the private `drawsBackground` KVC), which blocks App Store builds. Not relevant to Glimpse |
| Non-activating panel | Own `object_setClass` hack | Not built in; the community `tauri-nspanel` plugin uses the same class-swap technique |
| Windows Mica / Acrylic | `DwmSetWindowAttribute` via FFI | `apply_mica` / `apply_acrylic` / `apply_tabbed`: the same DWM attributes on 22H2+, `DWMWA_MICA_EFFECT` on 22000 |
| Windows 10 | Solid fallback; accent acrylic only as an experiment | `apply_acrylic` falls back to `SetWindowCompositionAttribute` and documents the laggy resize/drag; `apply_blur` for Windows 7/10 |
| Frameless + backdrop | `hiddenInset` keeps a DWM frame | Same problem: `decorations: false` drops the frame, so Tauri/tao keep shadow styles ("undecorated with shadow") |
| Corners on Windows 11 | `DWMWA_WINDOW_CORNER_PREFERENCE` via FFI | Not in `window-vibrancy`; tao/Tauri handle it with `shadow: true` on undecorated windows, or you call DWM yourself |
| Focus (`WS_EX_NOACTIVATE`) | FFI | `focus: false` at creation only; click-without-activation still needs `WS_EX_NOACTIVATE` through the `windows` crate (same WebView2 caveat) |
| Reduce transparency / settings events | Polling | Not in the crate either; Tauri has `theme-changed` events but no reduce-transparency event |
| Code we own | ~500 lines Objective-C + ~330 lines TS FFI | A few lines of Rust config; the crate is maintained and widely used |

**Bottom line:** the platform techniques are identical. Tauri just packages them in a
maintained crate and config, whereas with Electrobun we own them through `ptr` + FFI + a
dylib. Neither framework handles reduce transparency, settings events or a non-activating
panel properly out of the box. If Electrobun is chosen, items 1–6 in section 5 are good
upstream PRs. They map onto calls this spike already makes.

## 7. Expected results per check

| # | Check | macOS | Windows 11 22H2+ | Windows 10 |
|---|---|---|---|---|
| 1 | Material visible | Pass | Pass, possibly partial (backdrop + NOREDIRECTIONBITMAP + WebView2 unproven) | n/a (solid); accent-acrylic partial |
| 2 | Rounded corners | Pass with `mask`; `layer` may leave square blur | Pass | Pass by design (square) |
| 3 | Native shadow | Pass | Pass with `hiddenInset`; fail with `hidden` | Pass (square shadow) |
| 4 | Hairline | Pass | Pass (border None) | Pass |
| 5 | Show latency < 100 ms | Pass (expect 20–50 ms web frame) | Pass (expect 20–60 ms; cloak fastest) | Pass |
| 6 | No flash | Partial risk: stale content after hide | Partial risk: first show / stale content; cloak should pass | Same as Windows 11 |
| 7 | Focus not stolen on show | Pass (`orderFrontRegardless`) | Pass (`SW_SHOWNOACTIVATE`) | Pass |
| 8 | Focus not stolen on click | Partial (depends on the `NSPanel` re-class working) | Partial (WebView2 may take focus despite `WS_EX_NOACTIVATE`) | Partial |
| 9 | Reduce transparency | Pass (≤ 1 s poll lag) | Pass (≤ 1 s poll lag) | Pass |
| 10 | Dark/light live | Pass | Pass | Pass |
| 11 | Windows 10 fallback | n/a | n/a | Pass (solid); accent acrylic fail for shipping |
| 12 | Multi-monitor / mixed DPI | Pass (effect view is resolution independent) | Pass, possibly partial (DWM corners scale with DPI; check the webview radius matches) | Pass |
| 13 | Resize | Pass | Pass | Pass |
| 14 | Not in switcher | Pass (`IgnoresCycle`, panel) | Pass (`WS_EX_TOOLWINDOW`) | Pass |

Overall: **macOS pass (partial on click focus); Windows 11 partial (until the backdrop
behind a transparent WebView2 is seen working); Windows 10 pass for the designed solid
fallback.**

## 8. Design notes from the spike (for DESIGN.md / GLIM-27)

- **Veil opacity (open question 4).** The unit tests confirm the 90 % veil keeps all text
  ≥ 4.5:1 over pure white and pure black:
  - Light: primary 12.4:1, secondary 5.45:1. Dark: primary 10.1:1, secondary 5.53:1.
  - **At 80 %, secondary text fails the worst case** (light 4.24:1, dark 3.91:1). The
    minimum veil that keeps `text-secondary` at 4.5:1 is **83 % light / 85 % dark**.
  - So "about 80 %" needs a darker/lighter secondary text colour. The blur averages the
    backdrop, so real-world contrast is better than this worst case. The veil-opacity
    drop-down lets you judge visually how much material 90 % leaves.
- **Windows 10 corners:** DESIGN.md says 8 px on Windows. On Windows 10 that should be
  0 px (DWM can't round the frame or shadow). Suggest adding that to the radius rules.
- **Windows 11 DWM border:** DESIGN.md's webview hairline plus DWM's default 1 px border
  would double up. Set `DWMWA_BORDER_COLOR = NONE`, or drop the webview hairline on
  Windows.

## 9. What was verified here vs not

### Verified on headless Linux (x64)

- `hutch install` and `hutch electrobun sync` with Electrobun 2.0.6-beta.2.
- `tsc --noEmit` (TypeScript 5.9) passes for the main process, both views, the FFI modules
  and the tests, against the Electrobun devkit types.
- `hutch run test`: **19 tests pass**. They cover:
  - Windows build → capability table (21H2 vs 22H2 vs Windows 10);
  - material support per OS;
  - the surface decision (reduce transparency on, simulated or ignored, unsupported
    material);
  - the per-OS radius;
  - the `ACCENT_POLICY` (16 bytes) and x64 `WINDOWCOMPOSITIONATTRIBDATA` (24 bytes,
    pointer at offset 8) layouts;
  - DESIGN.md veil contrast;
  - latency stats.
- `hutch electrobun build --env=dev` produces a Linux bundle with the main process and both
  views (`views/popup`, `views/control`), so the build config and view entrypoints are
  correct.
- Read Electrobun's macOS and Windows native code at `a215432` for every claim above
  (window creation, transparency, show/hide, `ContainerView`, `WM_NCCALCSIZE`, WebView2
  background).

### Not verified

- **Nothing has run with a display.** No Windows or macOS build was produced (Hutch builds
  for the host OS only).
- **The Objective-C dylib has never been compiled.** There's no clang or macOS SDK here.
  Expect possible small compile fixes on first build: it targets the macOS 14 SDK API
  surface; `NSGlassEffectView` is accessed dynamically.
- The `object_setClass` panel swap, the occlusion-notification timing, and the
  `maskImage` corners on Electrobun's window.
- Every Win32/DWM FFI signature at runtime (struct layouts are unit-tested; HRESULTs are
  logged). Whether a system backdrop renders behind a transparent windowed WebView2 in a
  `WS_EX_NOREDIRECTIONBITMAP` window.
- WebView2 / WKWebView behaviour while hidden (stale frame on show), and actual latency
  numbers.
- No CI workflow was added. GitHub only reads workflows from the repo root, and this spike
  must stay under `spikes/window-materials/`. If wanted, add a `workflow_dispatch`-only
  workflow that runs `hutch run install && hutch run native:mac && hutch run build` on
  `macos-latest` (that would at least prove the dylib compiles) and `hutch run build` on
  `windows-latest`.

## 10. Files

- `src/bun/index.ts`: main process. Popup and control windows, apply/show/hide logic,
  timing, focus checks, settings polling, logging.
- `src/bun/mac.ts`: `bun:ffi` loader for the dylib.
- `src/bun/win.ts`: DWM / user32 / registry / version FFI.
- `native/macos/glimmaterial.m`, `native/macos/build.sh`: macOS helper (material,
  corners, shadow, panel, appearance, show timing, status).
- `src/popup/*`: popup webview with DESIGN.md tokens.
- `src/control/*`: control window.
- `src/shared/model.ts`: pure logic (capabilities, surface decision, struct layouts,
  contrast maths, stats), tested in `test/model.test.ts`.
- `src/shared/rpc.ts`: typed RPC schemas.
