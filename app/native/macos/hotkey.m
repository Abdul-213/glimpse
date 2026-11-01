// Global hotkeys for libglimpse.dylib (GLIM-44 / GLIM-23), ported from
// spikes/hotkeys/native/macos/glimhotkey.c.
//
// Carbon RegisterEventHotKey instead of Electrobun's GlobalShortcut, which on macOS is an
// NSEvent global monitor: it needs Accessibility, can't consume the keystroke, doesn't
// fire while Glimpse is frontmost, floods on auto-repeat and never reports conflicts
// (spikes/hotkeys/FINDINGS.md). Carbon hot keys need no permission, consume the key,
// fire everywhere and report eventHotKeyExistsErr (-9878) for another app's exclusive
// registration.
//
// Threading: Carbon Event Manager calls belong on the main thread, so every export hops
// there with dispatch_sync_f. The handler runs on the main thread and calls a JSCallback
// created with { threadsafe: true }, which queues the press onto the Bun worker.
#import <Carbon/Carbon.h>
#include <dispatch/dispatch.h>
#include <pthread.h>

#include "glimpse.h"

#define GLIM_HK_SIGNATURE 'GLMP'
#define GLIM_HK_MAX 32

// kind: 1 = pressed, 2 = released
typedef void (*glim_hotkey_cb)(int32_t id, int32_t kind);

static glim_hotkey_cb g_hk_cb = NULL;
static EventHandlerRef g_hk_handler = NULL;
static EventHandlerUPP g_hk_upp = NULL;
static EventHotKeyRef g_hk_refs[GLIM_HK_MAX];

static OSStatus glim_hk_handler(EventHandlerCallRef next, EventRef event, void *user) {
  (void)next;
  (void)user;
  EventHotKeyID hk;
  OSStatus st = GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, NULL, sizeof(hk), NULL, &hk);
  if (st != noErr || hk.signature != GLIM_HK_SIGNATURE) return eventNotHandledErr;
  int32_t kind = GetEventKind(event) == kEventHotKeyPressed ? 1 : 2;
  glim_hotkey_cb cb = g_hk_cb;
  if (cb) cb((int32_t)hk.id, kind);
  return noErr;
}

typedef struct {
  int op;  // 0 init, 1 register, 2 unregister, 3 unregister all, 4 shutdown
  int32_t id;
  uint32_t keyCode;
  uint32_t mods;
  OSStatus result;
} glim_hk_call;

static void glim_hk_do(void *ctx) {
  glim_hk_call *c = (glim_hk_call *)ctx;
  c->result = noErr;
  switch (c->op) {
    case 0: {
      if (g_hk_handler) break;
      EventTypeSpec types[2] = {
          {kEventClassKeyboard, kEventHotKeyPressed},
          {kEventClassKeyboard, kEventHotKeyReleased},
      };
      if (!g_hk_upp) g_hk_upp = NewEventHandlerUPP(glim_hk_handler);
      c->result = InstallEventHandler(GetApplicationEventTarget(), g_hk_upp, 2, types, NULL, &g_hk_handler);
      break;
    }
    case 1: {
      if (c->id < 0 || c->id >= GLIM_HK_MAX) {
        c->result = paramErr;
        break;
      }
      if (g_hk_refs[c->id]) {
        UnregisterEventHotKey(g_hk_refs[c->id]);
        g_hk_refs[c->id] = NULL;
      }
      EventHotKeyID hk = {GLIM_HK_SIGNATURE, (UInt32)c->id};
      EventHotKeyRef ref = NULL;
      // Exclusive: fail with eventHotKeyExistsErr if another app holds it exclusively.
      c->result = RegisterEventHotKey(c->keyCode, c->mods, hk, GetApplicationEventTarget(), kEventHotKeyExclusive, &ref);
      if (c->result == noErr) g_hk_refs[c->id] = ref;
      break;
    }
    case 2: {
      if (c->id < 0 || c->id >= GLIM_HK_MAX || !g_hk_refs[c->id]) break;
      c->result = UnregisterEventHotKey(g_hk_refs[c->id]);
      g_hk_refs[c->id] = NULL;
      break;
    }
    case 3:
    case 4: {
      for (int i = 0; i < GLIM_HK_MAX; i++) {
        if (g_hk_refs[i]) {
          UnregisterEventHotKey(g_hk_refs[i]);
          g_hk_refs[i] = NULL;
        }
      }
      if (c->op == 4 && g_hk_handler) {
        RemoveEventHandler(g_hk_handler);
        g_hk_handler = NULL;
        g_hk_cb = NULL;
      }
      break;
    }
  }
}

static int32_t glim_hk_on_main(glim_hk_call *c) {
  if (pthread_main_np()) {
    glim_hk_do(c);
  } else {
    dispatch_sync_f(dispatch_get_main_queue(), c, glim_hk_do);
  }
  if (c->result != noErr) glim_set_error("Carbon hot key op %d failed: OSStatus %d", c->op, (int)c->result);
  return (int32_t)c->result;
}

// Install the hot-key handler; `cb` gets (id, kind) for every press and release.
GLIM_EXPORT int32_t glim_hotkey_init(glim_hotkey_cb cb) {
  g_hk_cb = cb;
  glim_hk_call c = {0, 0, 0, 0, noErr};
  return glim_hk_on_main(&c);
}

// keyCode: kVK_* (physical key). mods: Carbon mask (cmdKey 0x100, shiftKey 0x200,
// optionKey 0x800, controlKey 0x1000). Returns the OSStatus (-9878 = held by another app).
GLIM_EXPORT int32_t glim_hotkey_register(int32_t id, uint32_t keyCode, uint32_t mods) {
  glim_hk_call c = {1, id, keyCode, mods, noErr};
  return glim_hk_on_main(&c);
}

GLIM_EXPORT int32_t glim_hotkey_unregister(int32_t id) {
  glim_hk_call c = {2, id, 0, 0, noErr};
  return glim_hk_on_main(&c);
}

GLIM_EXPORT int32_t glim_hotkey_unregister_all(void) {
  glim_hk_call c = {3, 0, 0, 0, noErr};
  return glim_hk_on_main(&c);
}

// Unregister everything and remove the handler (call before closing the JSCallback).
GLIM_EXPORT int32_t glim_hotkey_shutdown(void) {
  glim_hk_call c = {4, 0, 0, 0, noErr};
  return glim_hk_on_main(&c);
}
