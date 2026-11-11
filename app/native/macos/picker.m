// Region-picker helpers for libglimpse.dylib (GLIM-91, docs/design/specs/region-picker.md 7, 9.2, 9.3).
//
//   glim_list_windows   on-screen windows front to back, for window-edge snapping
//   glim_focus_save     remembers the frontmost app at hotkey time
//   glim_focus_restore  re-activates it on cancel / Live confirm
//
// Loupe pixels come from a ScreenCaptureKit stream (glim_capture_stream_sample in
// capture.m), not from here.
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <dispatch/dispatch.h>
#include <pthread.h>
#include <string.h>
#include <unistd.h>

#include "glimpse.h"

// Mirrors GlimWindowInfo in app/src/bun/native/window-info.ts (104 bytes, 8-aligned).
typedef struct {
  double x, y, w, h;  // global points, top-left origin of the menu-bar screen
  int32_t pid;
  int32_t z;          // 0 = frontmost
  char app_name[64];  // UTF-8, NUL-terminated; never the window title
} GlimWindowInfo;
_Static_assert(sizeof(GlimWindowInfo) == 104, "GlimWindowInfo layout is part of the ABI");

// UTF-8 into a fixed buffer without splitting a code point.
static void glim_copy_utf8(NSString *s, char *out, size_t cap) {
  out[0] = 0;
  if (!s || cap == 0) return;
  const char *u = s.UTF8String;
  if (!u) return;
  size_t len = strlen(u);
  if (len > cap - 1) {
    len = cap - 1;
    while (len > 0 && ((unsigned char)u[len] & 0xC0) == 0x80) len--;  // continuation byte
  }
  memcpy(out, u, len);
  out[len] = 0;
}

static double glim_num(NSDictionary *d, NSString *key, double fallback) {
  id v = d[key];
  return [v isKindOfClass:[NSNumber class]] ? [(NSNumber *)v doubleValue] : fallback;
}

// Fill out[0..cap) with normal windows (layer 0) and floating panels (layer 3) of other
// processes, front to back. Menu bar, Dock and status items (layer >= 20), invisible
// windows (alpha 0) and our own pid are dropped. *countOut = written; *totalOut
// (optional) = matched, which may exceed cap. CGWindowListCopyWindowInfo is a metadata
// call: not deprecated, thread-safe, and it doesn't need Screen Recording for bounds,
// owner pid and owner name (only kCGWindowName needs it, and we never read it).
GLIM_EXPORT int32_t glim_list_windows(GlimWindowInfo *out, int32_t cap, int32_t *countOut, int32_t *totalOut) {
  if (!countOut || cap < 0 || (cap > 0 && !out)) {
    glim_set_error("bad window list buffer");
    return GLIM_E_ARGS;
  }
  @autoreleasepool {
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
                                                 kCGNullWindowID);
    if (!list) {
      glim_set_error("CGWindowListCopyWindowInfo returned nothing");
      return GLIM_E_API;
    }
    NSArray *windows = CFBridgingRelease(list);
    pid_t me = getpid();
    int32_t count = 0, total = 0;
    for (NSDictionary *w in windows) {
      if (![w isKindOfClass:[NSDictionary class]]) continue;
      int layer = (int)glim_num(w, (__bridge NSString *)kCGWindowLayer, -1);
      if (layer != 0 && layer != 3) continue;
      pid_t pid = (pid_t)glim_num(w, (__bridge NSString *)kCGWindowOwnerPID, 0);
      if (pid == me) continue;
      if (glim_num(w, (__bridge NSString *)kCGWindowAlpha, 1) <= 0) continue;
      NSDictionary *bounds = w[(__bridge NSString *)kCGWindowBounds];
      CGRect r;
      if (![bounds isKindOfClass:[NSDictionary class]] ||
          !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds, &r))
        continue;
      if (r.size.width < 40 || r.size.height < 40) continue;
      int32_t z = total++;
      if (count >= cap) continue;  // keep counting so the caller can size up
      GlimWindowInfo *o = &out[count++];
      o->x = r.origin.x;
      o->y = r.origin.y;
      o->w = r.size.width;
      o->h = r.size.height;
      o->pid = (int32_t)pid;
      o->z = z;
      memset(o->app_name, 0, sizeof o->app_name);
      id owner = w[(__bridge NSString *)kCGWindowOwnerName];
      glim_copy_utf8([owner isKindOfClass:[NSString class]] ? owner : nil, o->app_name, sizeof o->app_name);
    }
    *countOut = count;
    if (totalOut) *totalOut = total;
    return GLIM_OK;
  }
}

// ---- focus (spec section 7) ------------------------------------------------

static pid_t g_saved_pid = 0;

typedef struct {
  int op;  // 0 save, 1 restore
  pid_t pid;
  int32_t restored;
  int32_t status;
} glim_focus_call;

static void glim_focus_do(void *ctx) {
  glim_focus_call *c = (glim_focus_call *)ctx;
  c->status = GLIM_OK;
  if (c->op == 0) {
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    c->pid = front ? front.processIdentifier : 0;
    return;
  }
  NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:c->pid];
  if (!app || app.terminated) return;  // the saved app is gone: do nothing (spec 7.4)
  if (app.processIdentifier == getpid()) return;
  // macOS 14 cooperative activation: we are the active app (the overlay was key), so
  // yielding to the target first lets its activation go through.
  [NSApp yieldActivationToApplication:app];
  c->restored = [app activateWithOptions:0] ? 1 : 0;
  if (!c->restored) {
    glim_set_error("activateWithOptions refused for pid %d", (int)c->pid);
    c->status = GLIM_E_API;
  }
}

static void glim_focus_on_main(glim_focus_call *c) {
  if (pthread_main_np()) {
    glim_focus_do(c);
  } else {
    dispatch_sync_f(dispatch_get_main_queue(), c, glim_focus_do);
  }
}

// Remember the frontmost app. *pidOut (optional) gets its pid, for logs.
GLIM_EXPORT int32_t glim_focus_save(uint64_t *pidOut) {
  glim_focus_call c = {0, 0, 0, GLIM_OK};
  glim_focus_on_main(&c);
  g_saved_pid = c.pid;
  if (pidOut) *pidOut = (uint64_t)c.pid;
  return c.status;
}

// Re-activate the saved app. *restoredOut = 1 if it was activated, 0 if there was nothing
// to restore (never saved, terminated, or it was Glimpse itself).
GLIM_EXPORT int32_t glim_focus_restore(int32_t *restoredOut) {
  if (restoredOut) *restoredOut = 0;
  pid_t pid = g_saved_pid;
  g_saved_pid = 0;
  if (pid <= 0) return GLIM_OK;
  glim_focus_call c = {1, pid, 0, GLIM_OK};
  glim_focus_on_main(&c);
  if (restoredOut) *restoredOut = c.restored;
  return c.status;
}
