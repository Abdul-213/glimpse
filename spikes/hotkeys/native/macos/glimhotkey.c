// GLIM-14 spike: Carbon RegisterEventHotKey wrapper, loaded from Bun with bun:ffi.
//
// Why a dylib and not raw bun:ffi calls into Carbon.framework:
//   * Electrobun runs app JS in a Bun Worker thread; the main thread runs the
//     AppKit event loop. Carbon Event Manager calls (InstallEventHandler,
//     RegisterEventHotKey) belong on the main thread, and the hot-key event is
//     dispatched there. bun:ffi can only call on the current (worker) thread.
//     This file hops to the main queue with dispatch_sync_f and calls back into
//     JS through a JSCallback created with { threadsafe: true }.
//   * Carbon's EventTypeSpec / EventHotKeyID structs are passed by value or by
//     pointer, which is awkward from bun:ffi; plain int32 exports are not.
//
// Build (macOS, needs Xcode Command Line Tools): `bun run native:mac`, which runs
//   clang -dynamiclib -framework Carbon -framework ApplicationServices
//         -o native/macos/build/libglimhotkey.dylib native/macos/glimhotkey.c
// and also builds the holder tool for conflict tests (-DGLIM_HOLDER_MAIN):
//   native/macos/build/glimhotkey-hold <keyCode> <carbonMods> [exclusive 0|1]

#include <Carbon/Carbon.h>
#include <ApplicationServices/ApplicationServices.h>
#include <dispatch/dispatch.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#define GLIM_SIGNATURE 'GLMP'
#define GLIM_MAX_HOTKEYS 32

// kind: 1 = pressed, 2 = released
typedef void (*glim_hotkey_cb)(int32_t id, int32_t kind);

static glim_hotkey_cb g_cb = NULL;
static EventHandlerRef g_handler = NULL;
static EventHotKeyRef g_refs[GLIM_MAX_HOTKEYS];

static OSStatus glim_handler(EventHandlerCallRef next, EventRef event, void *user) {
  (void)next;
  (void)user;
  EventHotKeyID hk;
  OSStatus st = GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID,
                                  NULL, sizeof(hk), NULL, &hk);
  if (st != noErr || hk.signature != GLIM_SIGNATURE) {
    return eventNotHandledErr;
  }
  int32_t kind = GetEventKind(event) == kEventHotKeyPressed ? 1 : 2;
  if (g_cb) {
    g_cb((int32_t)hk.id, kind);
  }
  return noErr;
}

// ---- main-thread trampolines -------------------------------------------

typedef struct {
  int op;  // 0 init, 1 register, 2 unregister, 3 unregister all, 4 shutdown
  int32_t id;
  uint32_t keyCode;
  uint32_t mods;
  uint32_t options;
  OSStatus result;
} glim_call;

static void glim_do(void *ctx) {
  glim_call *c = (glim_call *)ctx;
  c->result = noErr;
  switch (c->op) {
    case 0: {
      if (g_handler) break;
      EventTypeSpec types[2] = {
          {kEventClassKeyboard, kEventHotKeyPressed},
          {kEventClassKeyboard, kEventHotKeyReleased},
      };
      c->result = InstallEventHandler(GetApplicationEventTarget(),
                                      NewEventHandlerUPP(glim_handler), 2, types,
                                      NULL, &g_handler);
      break;
    }
    case 1: {
      if (c->id < 0 || c->id >= GLIM_MAX_HOTKEYS) {
        c->result = paramErr;
        break;
      }
      if (g_refs[c->id]) {
        UnregisterEventHotKey(g_refs[c->id]);
        g_refs[c->id] = NULL;
      }
      EventHotKeyID hk = {GLIM_SIGNATURE, (UInt32)c->id};
      EventHotKeyRef ref = NULL;
      c->result = RegisterEventHotKey(c->keyCode, c->mods, hk,
                                      GetApplicationEventTarget(), c->options, &ref);
      if (c->result == noErr) g_refs[c->id] = ref;
      break;
    }
    case 2: {
      if (c->id < 0 || c->id >= GLIM_MAX_HOTKEYS || !g_refs[c->id]) {
        c->result = paramErr;
        break;
      }
      c->result = UnregisterEventHotKey(g_refs[c->id]);
      g_refs[c->id] = NULL;
      break;
    }
    case 3:
    case 4: {
      for (int i = 0; i < GLIM_MAX_HOTKEYS; i++) {
        if (g_refs[i]) {
          UnregisterEventHotKey(g_refs[i]);
          g_refs[i] = NULL;
        }
      }
      if (c->op == 4 && g_handler) {
        RemoveEventHandler(g_handler);
        g_handler = NULL;
        g_cb = NULL;
      }
      break;
    }
  }
}

static OSStatus glim_on_main(glim_call *c) {
  if (pthread_main_np()) {
    glim_do(c);
  } else {
    dispatch_sync_f(dispatch_get_main_queue(), c, glim_do);
  }
  return c->result;
}

// ---- exports (all return OSStatus, 0 = noErr) ----------------------------

int32_t glim_hk_init(glim_hotkey_cb cb) {
  g_cb = cb;
  glim_call c = {0};
  c.op = 0;
  return glim_on_main(&c);
}

// keyCode: kVK_* virtual key code (physical key, layout independent).
// mods: Carbon modifier mask (cmdKey 0x100, shiftKey 0x200, optionKey 0x800,
// controlKey 0x1000). options: 0 or kEventHotKeyExclusive.
int32_t glim_hk_register(int32_t id, uint32_t keyCode, uint32_t mods, uint32_t options) {
  glim_call c = {0};
  c.op = 1;
  c.id = id;
  c.keyCode = keyCode;
  c.mods = mods;
  c.options = options;
  return glim_on_main(&c);
}

int32_t glim_hk_unregister(int32_t id) {
  glim_call c = {0};
  c.op = 2;
  c.id = id;
  return glim_on_main(&c);
}

int32_t glim_hk_unregister_all(void) {
  glim_call c = {0};
  c.op = 3;
  return glim_on_main(&c);
}

int32_t glim_hk_shutdown(void) {
  glim_call c = {0};
  c.op = 4;
  return glim_on_main(&c);
}

int32_t glim_hk_exclusive_flag(void) { return (int32_t)kEventHotKeyExclusive; }

// Diagnostics: is this process trusted for Accessibility? (What Electrobun's
// NSEvent global monitor silently depends on.)
int32_t glim_ax_trusted(void) { return AXIsProcessTrusted() ? 1 : 0; }

// Diagnostics: is Secure Event Input on (password field focused somewhere)?
int32_t glim_secure_input(void) { return IsSecureEventInputEnabled() ? 1 : 0; }

#ifdef GLIM_HOLDER_MAIN
// Tiny stand-alone process that holds one hot key, for conflict tests.
//   glimhotkey-hold <keyCode> <carbonMods> [exclusive 0|1]
//   e.g. Control+Shift+S:  glimhotkey-hold 1 4608 1
static void holder_cb(int32_t id, int32_t kind) {
  printf("holder: hot key %d %s\n", id, kind == 1 ? "pressed" : "released");
  fflush(stdout);
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s <keyCode> <carbonMods> [exclusive 0|1]\n", argv[0]);
    return 2;
  }
  uint32_t key = (uint32_t)strtoul(argv[1], NULL, 0);
  uint32_t mods = (uint32_t)strtoul(argv[2], NULL, 0);
  uint32_t opts = (argc > 3 && atoi(argv[3])) ? kEventHotKeyExclusive : 0;
  OSStatus st = glim_hk_init(holder_cb);
  if (st != noErr) {
    fprintf(stderr, "holder: InstallEventHandler failed: %d\n", (int)st);
    return 1;
  }
  st = glim_hk_register(0, key, mods, opts);
  printf("holder: RegisterEventHotKey(key=%u, mods=0x%x, options=%u) -> %d\n", key, mods,
         opts, (int)st);
  fflush(stdout);
  if (st != noErr) return 1;
  RunApplicationEventLoop();
  return 0;
}
#endif
