# macOS native helper (`libglimpse.dylib`)

The single macOS helper library, per [GLIM-26](../../../docs/decisions/GLIM-26-stack.md) and
[ARCHITECTURE.md](../../../ARCHITECTURE.md#6-native-helpers). Objective-C (ARC), C ABI, universal
arm64 + x86_64, minimum macOS 14.

| File | What |
|---|---|
| `glimpse.h` | Status codes (mirrored in `app/src/bun/native/status.ts`), ABI version, threading notes |
| `glimpse.m` | `glim_abi_version`, `glim_last_error` |
| `window.m` | NSWindow helpers on the main thread: `glim_window_exclude_from_capture` (`sharingType = none` + `CGWindowID`), `glim_window_number`, `glim_window_set_sharing` (GLIM-98: none or readOnly), and for picker overlays (GLIM-91) `glim_window_configure` (level 1000, collection behaviour for Spaces and fullscreen apps, no shadow, not movable, mouse-moved events) and `glim_window_set_level` |
| `capture.m` | ScreenCaptureKit capture (GLIM-36): `glim_capture_shot` (SCScreenshotManager, Snip), `glim_capture_stream_open/read/close` (SCStream, Live), `glim_capture_set_excluded_windows`, `glim_capture_reset`, `glim_capture_preflight`, `glim_capture_displays_json`, and `glim_capture_stream_sample` (a 15 × 15 px patch of a stream's newest frame, for the picker's loupe) |
| `hotkey.m` | Global hotkeys (GLIM-44, GLIM-23): Carbon `RegisterEventHotKey` (exclusive), handler on the main thread calling a threadsafe `JSCallback`. `glim_hotkey_init/register/unregister/unregister_all/shutdown`. No Accessibility permission needed; consumes the keystroke; `-9878` = held by another app. |
| `picker.m` | Region-picker helpers (GLIM-91): `glim_list_windows` (`CGWindowListCopyWindowInfo`, layers 0 and 3, our own pid dropped, owner name only, never the title), `glim_focus_save` / `glim_focus_restore` (frontmost app's pid; `yieldActivationToApplication:` + `activateWithOptions:`) |
| `frame.m` | Pinned Live frame (GLIM-90, live-popup.md §2.4/§12.2): `glim_frame_create/set_rect/set_style/set_highlight/show/window_id/info/destroy`. Borderless non-activating `NSPanel`, `ignoresMouseEvents`, level 101, all Spaces + fullscreen auxiliary, `sharingType = none`; a layer-hosting flipped view with `CAShapeLayer` ticks/halo/highlight and a `CATextLayer` tag chip. Global points (top-left) in. Links QuartzCore. |

Self-capture exclusion: every `SCContentFilter` excludes Glimpse's own `SCRunningApplication`
(or, if SCK doesn't list it, each window of this pid plus the ids from
`glim_capture_set_excluded_windows`). `sharingType = none` is set too but not relied on:
ScreenCaptureKit ignores it on macOS 15+ (`spikes/capture-exclusion/FINDINGS.md`).

## Build

```sh
xcode-select --install                 # once: Xcode Command Line Tools
sh app/native/macos/build.sh           # -> app/native/macos/build/libglimpse.dylib (arm64 + x86_64)
ARCHS=arm64 sh app/native/macos/build.sh
```

`electrobun.config.ts` copies `build/libglimpse.dylib` to `native/libglimpse.dylib` in the app
when building on macOS. CI compiles it on `macos-latest` (`.github/workflows/native.yml`).

## Rules

- Every AppKit call hops to the main thread with `dispatch_sync_f`/`dispatch_async_f` on the main
  queue: Electrobun runs app JS on a Bun Worker thread, not the AppKit main thread.
- ScreenCaptureKit completions are awaited on a semaphore (with a timeout) on the *calling*
  thread, never on the main queue.
- Callbacks into JS go through a `JSCallback` created with `threadsafe: true`.
- Exports are `glim_*` and return `int32` status (0 ok, -1..-99 Glimpse codes, else an NSError
  code such as -3801 "user declined"). Bump `GLIM_ABI` with `GLIM_ABI_VERSION` in
  `app/src/bun/native/load.ts`.
- Screen Recording permission is charged to the app that launched the process: test capture
  from the built `.app` opened with `open`, not from Terminal (spikes/capture/FINDINGS.md).
