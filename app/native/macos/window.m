// NSWindow helpers for window controllers. Electrobun's BrowserWindow.ptr is the
// NSWindow*; AppKit must be used on the main thread, so every call hops there.
// Ported from spikes/capture-exclusion/native/macos/glimcapture.m.
#import <AppKit/AppKit.h>
#include <dispatch/dispatch.h>
#include <pthread.h>

#include "glimpse.h"

typedef struct {
  int op;  // 0: sharingType = none + read windowNumber; 1: read windowNumber; 2: sharingType = readOnly
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
  } else if (c->op == 2) {
    // GLIM-98, "Hide Glimpse from screenshots and screen sharing" off: other apps may
    // capture the window again. Glimpse's own capture still skips it (SCK filter, capture.m).
    w.sharingType = NSWindowSharingReadOnly;
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

// GLIM-98: hidden != 0 sets sharingType = none, else readOnly (the AppKit default). Same
// out-params as glim_window_exclude_from_capture.
GLIM_EXPORT int32_t glim_window_set_sharing(void *window, int32_t hidden, uint32_t *windowNumberOut,
                                            int32_t *sharingOut) {
  if (!window) {
    glim_set_error("null window");
    return GLIM_E_ARGS;
  }
  glim_window_call c = {hidden ? 0 : 2, window, 0, -1, GLIM_E_API};
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

// ---- picker overlay windows (GLIM-91, region-picker spec 9.1) ---------------------

enum { GLIM_ROLE_OVERLAY = 0 };

typedef struct {
  void *window;
  int32_t role;
  int32_t level;  // for set_level; ignored by configure
  int64_t behavior;
  int32_t status;
} glim_overlay_call;

static NSWindow *glim_as_window(void *p) {
  id obj = (__bridge id)p;
  return (obj && [obj isKindOfClass:[NSWindow class]]) ? (NSWindow *)obj : nil;
}

static void glim_configure_do(void *ctx) {
  glim_overlay_call *c = (glim_overlay_call *)ctx;
  NSWindow *w = glim_as_window(c->window);
  if (!w) {
    c->status = GLIM_E_NOT_A_WINDOW;
    return;
  }
  if (c->role != GLIM_ROLE_OVERLAY) {
    glim_set_error("unknown window role %d", c->role);
    c->status = GLIM_E_ARGS;
    return;
  }
  // Above the menu bar (24) and Dock (20): NSScreenSaverWindowLevel. Electrobun's
  // setAlwaysOnTop only reaches NSFloatingWindowLevel (spikes/overlay/FINDINGS.md 3).
  w.level = NSScreenSaverWindowLevel;
  // Electrobun gives every window FullScreenPrimary, which excludes FullScreenAuxiliary.
  NSWindowCollectionBehavior b = w.collectionBehavior;
  b &= ~(NSWindowCollectionBehaviorFullScreenPrimary | NSWindowCollectionBehaviorMoveToActiveSpace |
         NSWindowCollectionBehaviorManaged);
  b |= NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary |
       NSWindowCollectionBehaviorIgnoresCycle | NSWindowCollectionBehaviorFullScreenAuxiliary;
  w.collectionBehavior = b;
  w.hasShadow = NO;
  w.opaque = NO;
  w.movable = NO;
  w.hidesOnDeactivate = NO;
  w.ignoresMouseEvents = NO;
  w.acceptsMouseMovedEvents = YES;
  w.sharingType = NSWindowSharingNone;
  c->behavior = (int64_t)w.collectionBehavior;
  c->status = GLIM_OK;
}

static void glim_set_level_do(void *ctx) {
  glim_overlay_call *c = (glim_overlay_call *)ctx;
  NSWindow *w = glim_as_window(c->window);
  if (!w) {
    c->status = GLIM_E_NOT_A_WINDOW;
    return;
  }
  w.level = (NSWindowLevel)c->level;
  c->status = GLIM_OK;
}

static int32_t glim_overlay_on_main(glim_overlay_call *c, dispatch_function_t fn) {
  if (pthread_main_np()) {
    fn(c);
  } else {
    dispatch_sync_f(dispatch_get_main_queue(), c, fn);
  }
  if (c->status == GLIM_E_NOT_A_WINDOW) glim_set_error("pointer is not an NSWindow");
  return c->status;
}

// Configure an Electrobun NSWindow for a role (0 = picker overlay): level, collection
// behaviour, shadow, movability, mouse-moved events, sharingType = none. Call while the
// window is still hidden. *behaviorOut (optional) = the collection behaviour read back.
GLIM_EXPORT int32_t glim_window_configure(void *window, int32_t role, int64_t *behaviorOut) {
  if (!window) {
    glim_set_error("null window");
    return GLIM_E_ARGS;
  }
  glim_overlay_call c = {window, role, 0, 0, GLIM_E_API};
  int32_t r = glim_overlay_on_main(&c, glim_configure_do);
  if (behaviorOut) *behaviorOut = c.behavior;
  return r;
}

// NSWindow.level (1000 while picking, 100 under the Snip popup on confirm).
GLIM_EXPORT int32_t glim_window_set_level(void *window, int32_t level) {
  if (!window) {
    glim_set_error("null window");
    return GLIM_E_ARGS;
  }
  glim_overlay_call c = {window, 0, level, 0, GLIM_E_API};
  return glim_overlay_on_main(&c, glim_set_level_do);
}
