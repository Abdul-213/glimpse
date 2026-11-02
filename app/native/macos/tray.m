// The menu-bar item's accessible name (GLIM-136) and its badged template image (GLIM-99).
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
// GLIM-99: Electrobun's setTrayImage replaces the button image without `setTemplate:` or the
// 16 pt size its createTray sets, so a badge change would draw a black, 32 pt icon on a dark
// menu bar. glim_tray_set_template_image sets the new image the way createTray does.
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
  __unsafe_unretained NSImage *image;   // glim_tray_set_template_image only
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

// Electrobun tray `trayId`'s status-bar button, or nil. Main thread.
static NSButton *glim_find_tray_button(uint32_t trayId) {
  if (!NSApp) return nil;
  NSMutableArray<NSButton *> *buttons = [NSMutableArray array];
  for (NSWindow *w in NSApp.windows) {
    if (![NSStringFromClass([w class]) containsString:@"StatusBar"]) continue;
    glim_collect_status_buttons(w.contentView.superview ?: w.contentView, buttons);
  }
  for (NSButton *b in buttons) {
    if (glim_button_has_tray_id(b, trayId)) return b;
  }
  return buttons.count == 1 ? buttons.firstObject : nil;
}

static void glim_tray_label_do(void *ctx) {
  glim_tray_call *c = (glim_tray_call *)ctx;
  NSButton *match = glim_find_tray_button(c->trayId);
  if (!match) {
    c->status = GLIM_E_UNSUPPORTED;
    return;
  }
  match.accessibilityLabel = c->label;
  c->status = GLIM_OK;
}

static void glim_tray_image_do(void *ctx) {
  glim_tray_call *c = (glim_tray_call *)ctx;
  NSButton *match = glim_find_tray_button(c->trayId);
  if (!match) {
    c->status = GLIM_E_UNSUPPORTED;
    return;
  }
  match.image = c->image;
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

// Set Electrobun tray `trayId`'s image to the PNG at `path` as a template image of
// `width` x `height` points (GLIM-99). GLIM_E_ARGS when the file can't be read as an image,
// GLIM_E_UNSUPPORTED when the status item isn't found.
GLIM_EXPORT int32_t glim_tray_set_template_image(uint32_t trayId, const char *path, double width, double height) {
  if (!path || !(width > 0) || !(height > 0)) {
    glim_set_error("bad tray image arguments");
    return GLIM_E_ARGS;
  }
  NSString *p = [NSString stringWithUTF8String:path];
  NSImage *image = p ? [[NSImage alloc] initWithContentsOfFile:p] : nil;
  if (!image) {
    glim_set_error("could not read tray image %s", path);
    return GLIM_E_ARGS;
  }
  [image setTemplate:YES];
  image.size = NSMakeSize(width, height);
  glim_tray_call c = {.trayId = trayId, .label = nil, .image = image, .status = GLIM_E_UNSUPPORTED};
  if (pthread_main_np()) {
    glim_tray_image_do(&c);
  } else {
    dispatch_sync_f(dispatch_get_main_queue(), &c, glim_tray_image_do);
  }
  if (c.status == GLIM_E_UNSUPPORTED) glim_set_error("status item for tray %u not found", trayId);
  return c.status;
}
