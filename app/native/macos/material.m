// Window material, appearance and frame helpers for libglimpse.dylib (GLIM-116, GLIM-110).
// Ported from spikes/window-materials/native/macos/glimmaterial.m (FINDINGS §2).
//
//   glim_window_set_material    NSVisualEffectView below the webview (behind-window, always
//                               active), rounded with a stretchable maskImage; hasShadow = YES
//                               (Electrobun sets NO on transparent windows) + invalidateShadow.
//   glim_window_set_appearance  NSWindow.appearance: nil (follow the system), aqua or darkAqua.
//                               The material tint and the WKWebView's prefers-color-scheme
//                               both follow it.
//   glim_window_set_frame       setFrame:display: from GLOBAL TOP-LEFT points (Electrobun's
//                               coordinate space), one call for position and size, so the
//                               anchored edge never jitters and the Y-flip bug in Electrobun's
//                               setFrame (spikes/overlay/FINDINGS.md §5) is avoided.
//   glim_reduce_transparency    System Settings › Accessibility › Display › Reduce transparency.
//
// Every call hops to the main thread (dispatch_sync_f), like window.m.
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <dispatch/dispatch.h>
#include <objc/runtime.h>
#include <pthread.h>
#include <stdio.h>

#include "glimpse.h"

static const void *kGlimFxKey = &kGlimFxKey;

typedef struct {
  int op;  // 0 material, 1 appearance, 2 frame, 3 info, 4 test create, 5 test destroy, 6 reduce transparency
  void *window;
  int32_t arg;
  double nums[4];
  char *buf;
  int32_t cap;
  int32_t len;
  void *out;
  int32_t status;
} glim_material_call;

static NSWindow *glim_mat_window(void *p) {
  id obj = (__bridge id)p;
  return (obj && [obj isKindOfClass:[NSWindow class]]) ? (NSWindow *)obj : nil;
}

// A resizable rounded-rect mask: the window server clips the behind-window backdrop to it,
// and the shadow follows the resulting alpha.
static NSImage *glim_rounded_mask(CGFloat radius) {
  CGFloat edge = radius * 2 + 1;
  NSImage *img = [NSImage imageWithSize:NSMakeSize(edge, edge)
                                flipped:NO
                         drawingHandler:^BOOL(NSRect rect) {
                           [[NSColor blackColor] setFill];
                           [[NSBezierPath bezierPathWithRoundedRect:rect xRadius:radius yRadius:radius] fill];
                           return YES;
                         }];
  img.capInsets = NSEdgeInsetsMake(radius, radius, radius, radius);
  img.resizingMode = NSImageResizingModeStretch;
  return img;
}

static NSString *glim_appearance_name(NSWindow *w) {
  NSAppearance *a = w.effectiveAppearance;
  NSAppearanceName best = [a bestMatchFromAppearancesWithNames:@[ NSAppearanceNameAqua, NSAppearanceNameDarkAqua ]];
  return best ?: @"unknown";
}

static void glim_material_do(void *ctx) {
  glim_material_call *c = (glim_material_call *)ctx;
  c->status = GLIM_OK;
  if (c->op == 6) {
    c->len = [NSWorkspace sharedWorkspace].accessibilityDisplayShouldReduceTransparency ? 1 : 0;
    return;
  }
  if (c->op == 4) {
    NSWindow *w = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 320, 120)
                                              styleMask:NSWindowStyleMaskBorderless
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    w.releasedWhenClosed = NO;
    w.opaque = NO;
    w.backgroundColor = [NSColor clearColor];
    w.contentView = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 320, 120)];
    c->out = (__bridge_retained void *)w;
    return;
  }
  if (c->op == 5) {
    NSWindow *w = (__bridge_transfer NSWindow *)c->window;
    [w orderOut:nil];
    [w close];
    return;
  }
  NSWindow *w = glim_mat_window(c->window);
  if (!w) {
    c->status = GLIM_E_NOT_A_WINDOW;
    return;
  }
  switch (c->op) {
    case 0: {
      NSView *content = w.contentView;
      if (!content) {
        glim_set_error("window has no content view");
        c->status = GLIM_E_API;
        return;
      }
      NSView *old = objc_getAssociatedObject(w, kGlimFxKey);
      if (old) {
        [old removeFromSuperview];
        objc_setAssociatedObject(w, kGlimFxKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      }
      if (c->arg >= 0) {
        content.wantsLayer = YES;
        NSVisualEffectView *v = [[NSVisualEffectView alloc] initWithFrame:content.bounds];
        v.material = (NSVisualEffectMaterial)c->arg;
        v.blendingMode = NSVisualEffectBlendingModeBehindWindow;
        // Popups are often not key; keep the active look.
        v.state = NSVisualEffectStateActive;
        CGFloat radius = (CGFloat)c->nums[0];
        if (radius > 0) v.maskImage = glim_rounded_mask(radius);
        v.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        // Below Electrobun's webview, which is a subview of its ContainerView.
        [content addSubview:v positioned:NSWindowBelow relativeTo:nil];
        objc_setAssociatedObject(w, kGlimFxKey, v, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        w.hasShadow = YES;
      }
      [w invalidateShadow];
      return;
    }
    case 1: {
      if (c->arg == 1) w.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
      else if (c->arg == 2) w.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
      else w.appearance = nil;
      [w invalidateShadow];
      return;
    }
    case 2: {
      // Global top-left points -> Cocoa's bottom-left space of the primary screen.
      NSScreen *primary = NSScreen.screens.firstObject;
      CGFloat h0 = primary ? primary.frame.size.height : 0;
      NSRect frame = NSMakeRect(c->nums[0], h0 - c->nums[1] - c->nums[3], c->nums[2], c->nums[3]);
      [w setFrame:frame display:YES animate:NO];
      [w invalidateShadow];
      return;
    }
    case 3: {
      NSVisualEffectView *v = objc_getAssociatedObject(w, kGlimFxKey);
      NSScreen *primary = NSScreen.screens.firstObject;
      CGFloat h0 = primary ? primary.frame.size.height : 0;
      NSRect f = w.frame;
      BOOL below = v && w.contentView.subviews.firstObject == v;
      char out[384];
      snprintf(out, sizeof out,
               "{\"effectView\":%d,\"material\":%ld,\"masked\":%d,\"below\":%d,\"hasShadow\":%d,\"dark\":%d,"
               "\"forced\":%d,\"x\":%.1f,\"y\":%.1f,\"w\":%.1f,\"h\":%.1f}",
               v ? 1 : 0, v ? (long)v.material : -1L, v.maskImage ? 1 : 0, below ? 1 : 0, w.hasShadow ? 1 : 0,
               [glim_appearance_name(w) isEqualToString:NSAppearanceNameDarkAqua] ? 1 : 0, w.appearance ? 1 : 0,
               f.origin.x, h0 - f.origin.y - f.size.height, f.size.width, f.size.height);
      c->len = glim_copy_out(out, c->buf, c->cap);
      return;
    }
    default:
      c->status = GLIM_E_ARGS;
  }
}

static int32_t glim_material_on_main(glim_material_call *c) {
  @autoreleasepool {
    if (pthread_main_np()) {
      glim_material_do(c);
    } else {
      dispatch_sync_f(dispatch_get_main_queue(), c, glim_material_do);
    }
  }
  if (c->status == GLIM_E_NOT_A_WINDOW) glim_set_error("pointer is not an NSWindow");
  return c->status;
}

// material: an NSVisualEffectMaterial raw value (popover 6, windowBackground 12, ...) or -1 to
// remove the effect view. radius: corner radius of the mask in points (0 = square).
GLIM_EXPORT int32_t glim_window_set_material(void *window, int32_t material, double radius) {
  if (!window) {
    glim_set_error("null window");
    return GLIM_E_ARGS;
  }
  glim_material_call c = {0, window, material, {radius, 0, 0, 0}, NULL, 0, 0, NULL, GLIM_E_API};
  return glim_material_on_main(&c);
}

// appearance: 0 follow the system, 1 light (aqua), 2 dark (darkAqua).
GLIM_EXPORT int32_t glim_window_set_appearance(void *window, int32_t appearance) {
  if (!window || appearance < 0 || appearance > 2) {
    glim_set_error("bad window or appearance");
    return GLIM_E_ARGS;
  }
  glim_material_call c = {1, window, appearance, {0, 0, 0, 0}, NULL, 0, 0, NULL, GLIM_E_API};
  return glim_material_on_main(&c);
}

// rect = {x, y, width, height} in global top-left points.
GLIM_EXPORT int32_t glim_window_set_frame(void *window, const double *rect) {
  if (!window || !rect || !(rect[2] > 0) || !(rect[3] > 0)) {
    glim_set_error("bad window or frame");
    return GLIM_E_ARGS;
  }
  glim_material_call c = {2, window, 0, {rect[0], rect[1], rect[2], rect[3]}, NULL, 0, 0, NULL, GLIM_E_API};
  return glim_material_on_main(&c);
}

// 1 when "Reduce transparency" is on, else 0.
GLIM_EXPORT int32_t glim_reduce_transparency(void) {
  glim_material_call c = {6, NULL, 0, {0, 0, 0, 0}, NULL, 0, 0, NULL, GLIM_E_API};
  glim_material_on_main(&c);
  return c.len;
}

// Diagnostics / smoke tests: {"effectView":0|1,"material":N,"masked":0|1,"below":0|1,
// "hasShadow":0|1,"dark":0|1,"forced":0|1,"x":..,"y":..,"w":..,"h":..} (frame in global
// top-left points). Returns the JSON length (-1 on failure).
GLIM_EXPORT int32_t glim_window_material_info(void *window, char *buf, int32_t cap) {
  if (!window) return -1;
  glim_material_call c = {3, window, 0, {0, 0, 0, 0}, buf, cap, 0, NULL, GLIM_E_API};
  return glim_material_on_main(&c) == GLIM_OK ? c.len : -1;
}

// Smoke tests only: a hidden borderless NSWindow with a plain content view, and its release.
GLIM_EXPORT int32_t glim_window_test_create(void **out) {
  if (!out) return GLIM_E_ARGS;
  glim_material_call c = {4, NULL, 0, {0, 0, 0, 0}, NULL, 0, 0, NULL, GLIM_E_API};
  int32_t r = glim_material_on_main(&c);
  *out = c.out;
  return r;
}

GLIM_EXPORT int32_t glim_window_test_destroy(void *window) {
  if (!window) return GLIM_E_ARGS;
  glim_material_call c = {5, window, 0, {0, 0, 0, 0}, NULL, 0, 0, NULL, GLIM_E_API};
  return glim_material_on_main(&c);
}
