// libglimpse.dylib: Glimpse's macOS native helper (ARCHITECTURE.md section 6).
//
// C ABI only. Every export is prefixed glim_ and returns an int32 status:
//   0            ok
//   -1 .. -99    Glimpse's own codes (below; mirrored in app/src/bun/native/status.ts)
//   anything else an NSError code (ScreenCaptureKit: -3801 user declined, ...)
// Text comes back through (char* buf, int32 cap) -> full length, NUL-terminated and
// truncated to cap. Pixel buffers are caller-owned (Bun allocates, native writes).
//
// Threading: app JS runs on a Bun Worker, not the AppKit main thread. Functions that
// touch NSWindow hop to the main queue with dispatch_sync_f. ScreenCaptureKit waits
// (GLIM-97) run on a helper-owned queue: the *_async exports return at once and report
// through the threadsafe completion callback set with glim_capture_async_init, so the Bun
// worker never blocks on SCK. They never touch the main queue, so they can't deadlock AppKit.
#pragma once
#include <stdint.h>

#define GLIM_EXPORT __attribute__((visibility("default")))

// Bump together with GLIM_ABI_VERSION in app/src/bun/native/load.ts.
#define GLIM_ABI 9

enum {
  GLIM_OK = 0,
  GLIM_E_ARGS = -1,
  GLIM_E_NO_DISPLAY = -2,
  GLIM_E_UNSUPPORTED = -3,
  GLIM_E_API = -4,
  GLIM_E_NO_FRAME = -5,
  GLIM_E_BACKEND = -6,
  GLIM_E_TIMEOUT = -7,
  GLIM_E_PERMISSION = -8,
  GLIM_E_NOT_A_WINDOW = -9,
};

void glim_set_error(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
int32_t glim_copy_out(const char *s, char *buf, int32_t cap);
GLIM_EXPORT int32_t glim_last_error(char *buf, int32_t cap);
