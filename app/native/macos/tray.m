// The menu-bar item's accessible name (GLIM-136).
//
// Electrobun's Tray draws an image-only NSStatusItem and its only text option, `title`, is
// visible text beside the icon, so VoiceOver reads the item as an unlabelled button (or the
// image file name). Electrobun keeps the NSStatusItem* to itself and hands Bun a u32 tray id,
// so this finds the status-bar button instead: status items live in NSStatusBarWindow
// instances that are part of NSApp.windows, and Electrobun sets each button's target to its
// StatusItemTarget, which carries `trayId` (nativeWrapper.mm, createTray). When no target
// matches but the app has exactly one status-bar button (Glimpse has one tray item), that one
// is used, so a renamed Electrobun class does not silently drop the label.
//
// Main thread only (AppKit): hops there with dispatch_sync_f like window.m.
#import <AppKit/AppKit.h>
#include <dispatch/dispatch.h>
#include <objc/message.h>
#include <objc/runtime.h>
#include <pthread.h>

#include "glimpse.h"

typedef struct {
  uint32_t trayId;
  __unsafe_unretained NSString *label;  // kept alive by the caller's frame
  int32_t status;
} glim_tray_call;

static BOOL glim_is_status_bar_button(NSView *v) {
  Class cls = NSClassFromString(@"NSStatusBarButton");
  return cls ? [v isKindOfClass:cls] : NO;
}

static void glim_collect_status_buttons(NSView *v, NSMutableArray<NSButton *> *out) {
  if (!v) return;
  if (glim_is_status_bar_button(v)) [out addObject:(NSButton *)v];
  for (NSView *sub in v.subviews) glim_collect_status_buttons(sub, out);
}

static BOOL glim_button_has_tray_id(NSButton *button, uint32_t trayId) {
  id target = button.target;
  SEL sel = NSSelectorFromString(@"trayId");
  if (!target || ![target respondsToSelector:sel]) return NO;
  uint32_t (*get)(id, SEL) = (uint32_t (*)(id, SEL))objc_msgSend;
  return get(target, sel) == trayId;
}

static void glim_tray_label_do(void *ctx) {
  glim_tray_call *c = (glim_tray_call *)ctx;
  if (!NSApp) {
    c->status = GLIM_E_UNSUPPORTED;
    return;
  }
  NSMutableArray<NSButton *> *buttons = [NSMutableArray array];
  for (NSWindow *w in NSApp.windows) {
    if (![NSStringFromClass([w class]) containsString:@"StatusBar"]) continue;
    glim_collect_status_buttons(w.contentView.superview ?: w.contentView, buttons);
  }
  NSButton *match = nil;
  for (NSButton *b in buttons) {
    if (glim_button_has_tray_id(b, c->trayId)) {
      match = b;
      break;
    }
  }
  if (!match && buttons.count == 1) match = buttons.firstObject;
  if (!match) {
    c->status = GLIM_E_UNSUPPORTED;
    return;
  }
  match.accessibilityLabel = c->label;
  c->status = GLIM_OK;
}

// Set the VoiceOver label of Electrobun tray `trayId`'s status-bar button to `utf8`.
// GLIM_E_UNSUPPORTED when no such button exists (no NSApp, tray hidden, Electrobun changed).
GLIM_EXPORT int32_t glim_tray_set_accessibility_label(uint32_t trayId, const char *utf8) {
  if (!utf8) {
    glim_set_error("null label");
    return GLIM_E_ARGS;
  }
  NSString *label = [NSString stringWithUTF8String:utf8];
  if (!label) {
    glim_set_error("label is not valid UTF-8");
    return GLIM_E_ARGS;
  }
  glim_tray_call c = {.trayId = trayId, .label = label, .status = GLIM_E_UNSUPPORTED};
  if (pthread_main_np()) {
    glim_tray_label_do(&c);
  } else {
    dispatch_sync_f(dispatch_get_main_queue(), &c, glim_tray_label_do);
  }
  if (c.status == GLIM_E_UNSUPPORTED) glim_set_error("status item for tray %u not found", trayId);
  return c.status;
}
