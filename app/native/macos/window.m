// NSWindow helpers for window controllers. Electrobun's BrowserWindow.ptr is the
// NSWindow*; AppKit must be used on the main thread, so every call hops there.
// Ported from spikes/capture-exclusion/native/macos/glimcapture.m.
#import <AppKit/AppKit.h>
#include <dispatch/dispatch.h>
#include <pthread.h>

#include "glimpse.h"

typedef struct {
  int op;  // 0: sharingType = none + read windowNumber; 1: read windowNumber
  void *window;
  uint32_t number;
  int32_t sharing;
  int32_t status;
} glim_window_call;

static void glim_window_do(void *ctx) {
  glim_window_call *c = (glim_window_call *)ctx;
  id obj = (__bridge id)c->window;
  if (!obj || ![obj isKindOfClass:[NSWindow class]]) {
    c->status = GLIM_E_NOT_A_WINDOW;
    return;
  }
  NSWindow *w = (NSWindow *)obj;
  if (c->op == 0) {
    // Keeps the window out of legacy CoreGraphics capture (and, on macOS 14, out of
    // other apps' ScreenCaptureKit captures). Glimpse's own capture does not rely on
    // it: the SCContentFilter excludes Glimpse explicitly (capture.m).
    w.sharingType = NSWindowSharingNone;
  }
  c->sharing = (int32_t)w.sharingType;
  // windowNumber == CGWindowID == SCWindow.windowID. <= 0 while the window has no
  // window-server window yet (created deferred and never shown).
  NSInteger n = w.windowNumber;
  c->number = n > 0 ? (uint32_t)n : 0;
  c->status = GLIM_OK;
}

static int32_t glim_window_on_main(glim_window_call *c) {
  if (pthread_main_np()) {
    glim_window_do(c);
  } else {
    dispatch_sync_f(dispatch_get_main_queue(), c, glim_window_do);
  }
  if (c->status == GLIM_E_NOT_A_WINDOW) glim_set_error("pointer is not an NSWindow");
  return c->status;
}

// Set NSWindow.sharingType = NSWindowSharingNone. Writes the CGWindowID (0 if the
// window has none yet) to *windowNumberOut and the sharingType read back to *sharingOut.
GLIM_EXPORT int32_t glim_window_exclude_from_capture(void *window, uint32_t *windowNumberOut, int32_t *sharingOut) {
  if (!window) {
    glim_set_error("null window");
    return GLIM_E_ARGS;
  }
  glim_window_call c = {0, window, 0, -1, GLIM_E_API};
  int32_t r = glim_window_on_main(&c);
  if (windowNumberOut) *windowNumberOut = c.number;
  if (sharingOut) *sharingOut = c.sharing;
  return r;
}

// CGWindowID of an NSWindow (0 if it has none yet).
GLIM_EXPORT int32_t glim_window_number(void *window, uint32_t *windowNumberOut) {
  if (!window) {
    glim_set_error("null window");
    return GLIM_E_ARGS;
  }
  glim_window_call c = {1, window, 0, -1, GLIM_E_API};
  int32_t r = glim_window_on_main(&c);
  if (windowNumberOut) *windowNumberOut = c.number;
  return r;
}
