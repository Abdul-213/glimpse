# macOS native helper (`libglimpse.dylib`)

Empty for now. This is where the single macOS helper library lives, per
[GLIM-26](../../../docs/decisions/GLIM-26-stack.md) and [ARCHITECTURE.md](../../../ARCHITECTURE.md#native-helpers).

- Source: Objective-C (`.m`) or Swift, one library for all macOS gaps: window level and
  collection behaviour, `NSVisualEffectView` materials, `sharingType` capture exclusion,
  ScreenCaptureKit capture, Carbon hotkeys.
- Build: `build.sh` here, `clang -dynamiclib -fobjc-arc -arch arm64 -arch x86_64
  -mmacosx-version-min=14.0`, output to `build/libglimpse.dylib` (gitignored). See
  `spikes/window-materials/native/macos/build.sh` and `spikes/capture/native/macos/` for working
  starting points.
- Every AppKit call hops to the main thread with `dispatch_sync_f`/`dispatch_async_f` on the main
  queue: Electrobun runs app JS on a Bun Worker thread, not the AppKit main thread.
- Callbacks into JS go through a `JSCallback` created with `threadsafe: true`.
- Exported C symbols are prefixed `glim_` and return plain status codes (0 = ok); the TypeScript
  side (`app/src/bun/native/macos.ts`) turns them into typed results.
- Packaged next to the main bundle via `electrobun.config.ts` `copy`, only when building on macOS.
- Compiled in CI on a macOS runner (GLIM-34); it cannot be built on the Linux dev box.
