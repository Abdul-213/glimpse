// GLIM-19 spike: native material behind Electrobun's WKWebView, a non-activating
// panel, appearance / reduce-transparency queries and show/hide timing.
// Loaded from Bun with bun:ffi (src/bun/mac.ts) and called with the NSWindow*
// that Electrobun exposes as BrowserWindow.ptr.
//
// Same threading model as the GLIM-14 / GLIM-16 helpers: Electrobun runs app JS
// on a Bun Worker, the main thread runs AppKit, so every function hops to the
// main thread with dispatch_sync (or runs inline if already on it).
//
// What Electrobun already does for `transparent: true` (nativeWrapper.mm @a215432):
//   window.opaque = NO, backgroundColor = clear, hasShadow = NO, content layer
//   clear, WKWebView drawsBackground = NO. It does not set
//   underPageBackgroundColor, never adds a material, never rounds the window,
//   and its windows are ElectrobunWindow : NSWindow (not NSPanel).
//
// Electrobun's window.contentView is its ContainerView; the WKWebView is a
// subview of it. We insert our effect view as the *bottom* subview of that
// ContainerView, so the webview stays on top and Electrobun's own bookkeeping
// (abstractViews array, not the subview list) is untouched.
//
// Build: native/macos/build.sh (hutch run native:mac). macOS 14+ deployment
// target; NSGlassEffectView (macOS 26) is looked up at runtime so an older SDK
// still compiles this file.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#include <dispatch/dispatch.h>
#include <objc/message.h>
#include <objc/runtime.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

// ---- helpers --------------------------------------------------------------

static void on_main(dispatch_block_t block) {
  if (pthread_main_np()) {
    block();
  } else {
    dispatch_sync(dispatch_get_main_queue(), block);
  }
}

static uint64_t now_ns(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }

static int32_t write_json(NSDictionary *dict, char *out, int32_t outLen) {
  if (!out || outLen <= 0) return -1;
  NSError *err = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:dict options:0 error:&err];
  if (!data) {
    snprintf(out, (size_t)outLen, "{\"error\":\"json\"}");
    return -10;
  }
  if ((int32_t)data.length >= outLen) {
    snprintf(out, (size_t)outLen, "{\"error\":\"buffer too small\"}");
    return -11;
  }
  memcpy(out, data.bytes, data.length);
  out[data.length] = 0;
  return 0;
}

static NSWindow *as_window(void *p) {
  id obj = (__bridge id)p;
  if (!obj || ![obj isKindOfClass:[NSWindow class]]) return nil;
  return (NSWindow *)obj;
}

static WKWebView *find_webview(NSView *root) {
  if (!root) return nil;
  if ([root isKindOfClass:[WKWebView class]]) return (WKWebView *)root;
  for (NSView *sub in root.subviews) {
    WKWebView *w = find_webview(sub);
    if (w) return w;
  }
  return nil;
}

// ---- per-window state -----------------------------------------------------

static const void *kFxKey = &kFxKey;          // NSView (effect or glass)
static const void *kStateKey = &kStateKey;    // NSMutableDictionary
static const void *kObserverKey = &kObserverKey;

// Timing for the occlusion-based "first visible" measurement.
static volatile uint64_t g_show_request_ns = 0;
static volatile uint64_t g_visible_ns = 0;
static volatile uint64_t g_order_done_ns = 0;

static NSMutableDictionary *state_for(NSWindow *w) {
  NSMutableDictionary *s = objc_getAssociatedObject(w, kStateKey);
  if (!s) {
    s = [NSMutableDictionary dictionary];
    objc_setAssociatedObject(w, kStateKey, s, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  return s;
}

// A resizable rounded-rect mask. Apple's documented way to round an
// NSVisualEffectView in behind-window mode: the window server clips the
// backdrop to the mask, and the window shadow follows the resulting alpha.
static NSImage *rounded_mask(CGFloat radius) {
  CGFloat edge = radius * 2 + 1;
  NSImage *img = [NSImage imageWithSize:NSMakeSize(edge, edge)
                                flipped:NO
                         drawingHandler:^BOOL(NSRect rect) {
                           [[NSColor blackColor] setFill];
                           [[NSBezierPath bezierPathWithRoundedRect:rect
                                                            xRadius:radius
                                                            yRadius:radius] fill];
                           return YES;
                         }];
  img.capInsets = NSEdgeInsetsMake(radius, radius, radius, radius);
  img.resizingMode = NSImageResizingModeStretch;
  return img;
}

// ---- non-activating panel -------------------------------------------------

// Electrobun creates ElectrobunWindow : NSWindow. NSWindowStyleMaskNonactivatingPanel
// only works on NSPanel, so we re-class the instance to this NSPanel subclass,
// the same trick the electron-panel-window module uses. It's only safe when the
// two classes have identical instance sizes (checked below) and the object
// isn't KVO-isa-swizzled.
@interface GlimPanel : NSPanel
@end
@implementation GlimPanel
- (BOOL)canBecomeKeyWindow {
  return YES;
}
- (BOOL)canBecomeMainWindow {
  return NO;
}
@end

static NSDictionary *make_panel(NSWindow *w) {
  Class before = object_getClass(w);
  NSString *beforeName = NSStringFromClass(before);
  size_t sizeBefore = class_getInstanceSize(before);
  size_t sizePanel = class_getInstanceSize([GlimPanel class]);
  BOOL swapped = NO;
  NSString *why = @"";
  if ([w isKindOfClass:[NSPanel class]]) {
    why = @"already a panel";
  } else if (![beforeName isEqualToString:@"ElectrobunWindow"]) {
    why = [NSString stringWithFormat:@"unexpected class %@ (KVO?)", beforeName];
  } else if (sizeBefore != sizePanel) {
    why = [NSString stringWithFormat:@"instance size differs (%zu vs %zu)", sizeBefore, sizePanel];
  } else {
    object_setClass(w, [GlimPanel class]);
    swapped = YES;
  }
  BOOL preventsActivation = NO;
  if ([w isKindOfClass:[NSPanel class]]) {
    NSPanel *p = (NSPanel *)w;
    p.styleMask = p.styleMask | NSWindowStyleMaskNonactivatingPanel;
    p.becomesKeyOnlyIfNeeded = YES;
    p.floatingPanel = YES;
    p.hidesOnDeactivate = NO;
    p.worksWhenModal = YES;
    // Private, best effort: makes the window server treat the window as
    // non-activating even though it was created as a normal window.
    SEL sel = NSSelectorFromString(@"_setPreventsActivation:");
    if ([p respondsToSelector:sel]) {
      ((void (*)(id, SEL, BOOL))objc_msgSend)(p, sel, YES);
      preventsActivation = YES;
    }
  }
  return @{
    @"classBefore" : beforeName,
    @"classAfter" : NSStringFromClass(object_getClass(w)),
    @"swapped" : @(swapped),
    @"reason" : why,
    @"privatePreventsActivation" : @(preventsActivation),
    @"nonactivatingBit" : @((w.styleMask & NSWindowStyleMaskNonactivatingPanel) != 0),
  };
}

// ---- material ---------------------------------------------------------------

// material: -1 none; 1000 = NSGlassEffectView (macOS 26); otherwise an
// NSVisualEffectMaterial raw value (popover 6, hudWindow 13, menu 5,
// sidebar 7, windowBackground 12, underWindowBackground 21, sheet 11).
// cornerMethod: 0 = effect-view maskImage (recommended), 1 = layer cornerRadius
// on the content view (clips webview and material together).
static void apply_material(NSWindow *w, int32_t material, int32_t radius, int32_t cornerMethod) {
  NSView *content = w.contentView;
  content.wantsLayer = YES;
  NSView *old = objc_getAssociatedObject(w, kFxKey);
  if (old) {
    [old removeFromSuperview];
    objc_setAssociatedObject(w, kFxKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  NSMutableDictionary *s = state_for(w);
  s[@"material"] = @(material);
  s[@"radius"] = @(radius);
  s[@"cornerMethod"] = @(cornerMethod);
  s[@"materialView"] = @"none";

  // Corner clipping of the whole content view (method 1) or none (method 0).
  if (cornerMethod == 1) {
    content.layer.cornerRadius = radius;
    content.layer.cornerCurve = kCACornerCurveContinuous;
    content.layer.masksToBounds = YES;
  } else {
    content.layer.cornerRadius = 0;
    content.layer.masksToBounds = NO;
  }

  NSView *fx = nil;
  if (material == 1000) {
    Class glass = NSClassFromString(@"NSGlassEffectView");
    if (glass) {
      fx = [[glass alloc] initWithFrame:content.bounds];
      @try {
        [fx setValue:@((CGFloat)radius) forKey:@"cornerRadius"];
      } @catch (NSException *e) {
        s[@"glassCornerError"] = e.reason ?: @"?";
      }
      s[@"materialView"] = @"NSGlassEffectView";
    } else {
      s[@"materialView"] = @"NSGlassEffectView unavailable (needs macOS 26)";
    }
  } else if (material >= 0) {
    NSVisualEffectView *v = [[NSVisualEffectView alloc] initWithFrame:content.bounds];
    v.material = (NSVisualEffectMaterial)material;
    v.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    // Popups are usually not key; force the active look.
    v.state = NSVisualEffectStateActive;
    if (cornerMethod == 0 && radius > 0) v.maskImage = rounded_mask(radius);
    fx = v;
    s[@"materialView"] = @"NSVisualEffectView";
  }
  if (fx) {
    fx.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    fx.frame = content.bounds;
    [content addSubview:fx positioned:NSWindowBelow relativeTo:nil];
    objc_setAssociatedObject(w, kFxKey, fx, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  w.hasShadow = YES;
  [w invalidateShadow];
}

static void ensure_occlusion_observer(NSWindow *w) {
  if (objc_getAssociatedObject(w, kObserverKey)) return;
  id token = [[NSNotificationCenter defaultCenter]
      addObserverForName:NSWindowDidChangeOcclusionStateNotification
                  object:w
                   queue:nil
              usingBlock:^(NSNotification *note) {
                NSWindow *win = note.object;
                if ((win.occlusionState & NSWindowOcclusionStateVisible) && g_visible_ns == 0 &&
                    g_show_request_ns != 0) {
                  g_visible_ns = now_ns();
                }
              }];
  objc_setAssociatedObject(w, kObserverKey, token, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

// ---- exported API -------------------------------------------------------------

// One-time setup of the popup window. Returns JSON describing what happened.
int32_t glim_mat_install(void *window, int32_t material, int32_t radius, int32_t cornerMethod,
                         int32_t panel, int32_t level, char *out, int32_t outLen) {
  __block NSDictionary *result = nil;
  on_main(^{
    NSWindow *w = as_window(window);
    if (!w) {
      result = @{@"error" : @"not an NSWindow"};
      return;
    }
    NSMutableDictionary *r = [NSMutableDictionary dictionary];
    r[@"electrobunDefaults"] = @{
      @"opaque" : @(w.opaque),
      @"hasShadow" : @(w.hasShadow),
      @"backgroundIsClear" : @([w.backgroundColor isEqual:[NSColor clearColor]]),
      @"styleMask" : @(w.styleMask),
      @"collectionBehavior" : @(w.collectionBehavior),
      @"level" : @(w.level),
      @"contentViewClass" : NSStringFromClass([w.contentView class]),
    };
    w.opaque = NO;
    w.backgroundColor = [NSColor clearColor];
    w.hasShadow = YES;
    w.movableByWindowBackground = NO;
    // Popup, not a document window: drop FullScreenPrimary (Electrobun adds it to
    // every window), join all Spaces and appear over fullscreen apps.
    NSWindowCollectionBehavior b = w.collectionBehavior;
    b &= ~(NSWindowCollectionBehaviorFullScreenPrimary | NSWindowCollectionBehaviorMoveToActiveSpace |
           NSWindowCollectionBehaviorManaged);
    b |= NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary |
         NSWindowCollectionBehaviorIgnoresCycle;
    w.collectionBehavior = b;
    if (level >= 0) w.level = level;

    if (panel) r[@"panel"] = make_panel(w);

    WKWebView *web = find_webview(w.contentView);
    if (web) {
      r[@"webview"] = @YES;
      r[@"webviewDrawsBackground"] = [web valueForKey:@"drawsBackground"] ?: @"?";
      // Electrobun only sets drawsBackground = NO. The under-page colour shows on
      // rubber-band overscroll and, on some versions, briefly before first paint.
      if (@available(macOS 12.0, *)) {
        web.underPageBackgroundColor = [NSColor clearColor];
        r[@"underPageBackgroundCleared"] = @YES;
      }
      web.wantsLayer = YES;
      web.layer.backgroundColor = [[NSColor clearColor] CGColor];
      web.layer.opaque = NO;
    } else {
      r[@"webview"] = @NO;
    }

    apply_material(w, material, radius, cornerMethod);
    ensure_occlusion_observer(w);
    r[@"state"] = [state_for(w) copy];
    r[@"after"] = @{
      @"opaque" : @(w.opaque),
      @"hasShadow" : @(w.hasShadow),
      @"styleMask" : @(w.styleMask),
      @"collectionBehavior" : @(w.collectionBehavior),
      @"level" : @(w.level),
      @"class" : NSStringFromClass(object_getClass(w)),
    };
    result = r;
  });
  return write_json(result, out, outLen);
}

int32_t glim_mat_set_material(void *window, int32_t material, int32_t radius, int32_t cornerMethod) {
  __block int32_t rc = 0;
  on_main(^{
    NSWindow *w = as_window(window);
    if (!w) {
      rc = -1;
      return;
    }
    apply_material(w, material, radius, cornerMethod);
  });
  return rc;
}

// mode: 0 follow system, 1 light (aqua), 2 dark (darkAqua). The effect view and
// the WKWebView (prefers-color-scheme) both follow the window's appearance.
int32_t glim_mat_set_appearance(void *window, int32_t mode) {
  __block int32_t rc = 0;
  on_main(^{
    NSWindow *w = as_window(window);
    if (!w) {
      rc = -1;
      return;
    }
    if (mode == 1)
      w.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
    else if (mode == 2)
      w.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    else
      w.appearance = nil;
    [w invalidateShadow];
  });
  return rc;
}

// mode: 0 orderFrontRegardless (no activation), 1 makeKeyAndOrderFront +
// activateIgnoringOtherApps (what Electrobun's show() does), 2 alpha 1 +
// accept mouse (window stays ordered in while "hidden").
int32_t glim_mat_show(void *window, int32_t mode) {
  g_show_request_ns = now_ns();
  g_visible_ns = 0;
  g_order_done_ns = 0;
  __block int32_t rc = 0;
  on_main(^{
    NSWindow *w = as_window(window);
    if (!w) {
      rc = -1;
      return;
    }
    if (mode == 2) {
      w.ignoresMouseEvents = NO;
      if (!w.visible) [w orderFrontRegardless];
      w.alphaValue = 1.0;
    } else if (mode == 1) {
      w.alphaValue = 1.0;
      [w makeKeyAndOrderFront:nil];
      [NSApp activateIgnoringOtherApps:YES];
    } else {
      w.alphaValue = 1.0;
      [w orderFrontRegardless];
    }
    [w invalidateShadow];
    [CATransaction flush];
    g_order_done_ns = now_ns();
  });
  return rc;
}

int32_t glim_mat_hide(void *window, int32_t mode) {
  __block int32_t rc = 0;
  on_main(^{
    NSWindow *w = as_window(window);
    if (!w) {
      rc = -1;
      return;
    }
    if (mode == 2) {
      if (!w.visible) [w orderFrontRegardless];
      w.alphaValue = 0.0;
      w.ignoresMouseEvents = YES;
    } else {
      [w orderOut:nil];
    }
  });
  return rc;
}

// Native timing of the last show, in microseconds since the show request.
// orderDoneUs: AppKit calls + CATransaction flush returned.
// visibleUs:   NSWindowDidChangeOcclusionStateNotification reported visible
//              (0 if it has not fired, e.g. the window was already visible).
int32_t glim_mat_last_show_timing(char *out, int32_t outLen) {
  uint64_t req = g_show_request_ns;
  NSDictionary *d = @{
    @"orderDoneUs" : @(g_order_done_ns && req ? (double)(g_order_done_ns - req) / 1000.0 : 0),
    @"visibleUs" : @(g_visible_ns && req ? (double)(g_visible_ns - req) / 1000.0 : 0),
  };
  return write_json(d, out, outLen);
}

// Centre the window in screen `index`'s visible frame (Cocoa coordinates, so it
// avoids Electrobun's setWindowFrame Y-flip bug on secondary displays).
int32_t glim_mat_move_to_screen(void *window, int32_t index) {
  __block int32_t count = 0;
  on_main(^{
    NSWindow *w = as_window(window);
    NSArray<NSScreen *> *screens = [NSScreen screens];
    count = (int32_t)screens.count;
    if (!w || count == 0) return;
    NSScreen *s = screens[(NSUInteger)(index % count)];
    NSRect vf = s.visibleFrame;
    NSRect f = w.frame;
    f.origin.x = NSMidX(vf) - f.size.width / 2;
    f.origin.y = NSMidY(vf) - f.size.height / 2;
    [w setFrame:f display:YES];
    [w invalidateShadow];
  });
  return count;
}

int32_t glim_mat_status(void *window, char *out, int32_t outLen) {
  __block NSDictionary *result = nil;
  on_main(^{
    NSWorkspace *ws = [NSWorkspace sharedWorkspace];
    NSRunningApplication *front = ws.frontmostApplication;
    NSMutableDictionary *r = [NSMutableDictionary dictionary];
    r[@"reduceTransparency"] = @(ws.accessibilityDisplayShouldReduceTransparency);
    r[@"increaseContrast"] = @(ws.accessibilityDisplayShouldIncreaseContrast);
    r[@"reduceMotion"] = @(ws.accessibilityDisplayShouldReduceMotion);
    NSAppearanceName sys =
        [NSApp.effectiveAppearance bestMatchFromAppearancesWithNames:@[ NSAppearanceNameAqua, NSAppearanceNameDarkAqua ]];
    r[@"systemDark"] = @([sys isEqualToString:NSAppearanceNameDarkAqua]);
    r[@"pid"] = @(getpid());
    r[@"frontmostPid"] = @(front ? front.processIdentifier : -1);
    r[@"frontmostName"] = front.localizedName ?: @"";
    r[@"appActive"] = @(NSApp.active);
    r[@"glassAvailable"] = @(NSClassFromString(@"NSGlassEffectView") != nil);
    NSOperatingSystemVersion v = [[NSProcessInfo processInfo] operatingSystemVersion];
    r[@"osVersion"] = [NSString stringWithFormat:@"%ld.%ld.%ld", (long)v.majorVersion,
                                                 (long)v.minorVersion, (long)v.patchVersion];
    NSWindow *w = as_window(window);
    if (w) {
      NSAppearanceName wa =
          [w.effectiveAppearance bestMatchFromAppearancesWithNames:@[ NSAppearanceNameAqua, NSAppearanceNameDarkAqua ]];
      r[@"window"] = @{
        @"class" : NSStringFromClass(object_getClass(w)),
        @"visible" : @(w.visible),
        @"key" : @(w.keyWindow),
        @"alpha" : @(w.alphaValue),
        @"opaque" : @(w.opaque),
        @"hasShadow" : @(w.hasShadow),
        @"level" : @(w.level),
        @"styleMask" : @(w.styleMask),
        @"occlusionVisible" : @((w.occlusionState & NSWindowOcclusionStateVisible) != 0),
        @"effectiveDark" : @([wa isEqualToString:NSAppearanceNameDarkAqua]),
        @"backingScale" : @(w.backingScaleFactor),
        @"screen" : w.screen.localizedName ?: @"",
        @"frame" : NSStringFromRect(w.frame),
        @"material" : [state_for(w) copy],
      };
    }
    result = r;
  });
  return write_json(result, out, outLen);
}

uint64_t glim_mat_now_ns(void) { return now_ns(); }
