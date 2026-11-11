// Screen lock / unlock and sleep / wake notifications for libglimpse.dylib (GLIM-119).
// Electrobun 2.0.6-beta.2 reports none of them; Live pauses on them (live-popup.md L17) and
// the translation cache is wiped on lock and sleep (GLIM-20).
//
//   lock    com.apple.screenIsLocked (distributed), NSWorkspaceSessionDidResignActive (fast
//           user switch away from this session)
//   unlock  com.apple.screenIsUnlocked (distributed), NSWorkspaceSessionDidBecomeActive
//   sleep   NSWorkspaceWillSleep (system), NSWorkspaceScreensDidSleep (displays off)
//   wake    NSWorkspaceDidWake, NSWorkspaceScreensDidWake
//
// Several notifications map to one kind (a lid close sends screensDidSleep, screenIsLocked
// and willSleep); the TypeScript side (services/session/presence.ts) folds duplicates.
//
// Threading: observers are added on the main thread (dispatch_sync_f) with queue:nil, so
// AppKit delivers them on the main run loop, which Electrobun runs. The callback is a
// JSCallback created with { threadsafe: true }: it queues the event onto the Bun worker.
// Without a running main run loop (native-smoke.ts under plain Bun) nothing is delivered
// until glim_session_pump() runs the loop for a moment.
#import <AppKit/AppKit.h>
#include <dispatch/dispatch.h>
#include <pthread.h>
#include <stdio.h>

#include "glimpse.h"

// kind: 1 lock, 2 unlock, 3 sleep, 4 wake. source: which notification (diagnostics).
typedef void (*glim_session_cb)(int32_t kind, int32_t source);

enum { GLIM_SESSION_LOCK = 1, GLIM_SESSION_UNLOCK = 2, GLIM_SESSION_SLEEP = 3, GLIM_SESSION_WAKE = 4 };

// Test notification for native-smoke.ts: object = "1".."4" (a kind). Never posted by macOS.
static NSString *const kGlimSessionTest = @"dev.glimpse.session.simulate";

static glim_session_cb g_session_cb = NULL;
static NSMutableArray *g_session_tokens = nil;  // { center, token } pairs, main thread only
static int32_t g_session_observers = 0;

static void glim_session_emit(int32_t kind, int32_t source) {
  glim_session_cb cb = g_session_cb;
  if (cb) cb(kind, source);
}

static void glim_session_observe(NSNotificationCenter *center, NSString *name, int32_t kind, int32_t source) {
  id token = [center addObserverForName:name
                                 object:nil
                                  queue:nil
                             usingBlock:^(NSNotification *note) {
                               glim_session_emit(kind, source);
                             }];
  [g_session_tokens addObject:@[ center, token ]];
  g_session_observers++;
}

typedef struct {
  int op;  // 0 start, 1 stop
  int32_t status;
} glim_session_call;

static void glim_session_do(void *ctx) {
  glim_session_call *c = (glim_session_call *)ctx;
  c->status = GLIM_OK;
  if (c->op == 0) {
    if (g_session_tokens) return;  // already observing; the callback was swapped
    g_session_tokens = [NSMutableArray array];
    g_session_observers = 0;
    NSDistributedNotificationCenter *dist = [NSDistributedNotificationCenter defaultCenter];
    NSNotificationCenter *ws = [[NSWorkspace sharedWorkspace] notificationCenter];
    glim_session_observe(dist, @"com.apple.screenIsLocked", GLIM_SESSION_LOCK, 1);
    glim_session_observe(dist, @"com.apple.screenIsUnlocked", GLIM_SESSION_UNLOCK, 2);
    glim_session_observe(ws, NSWorkspaceSessionDidResignActiveNotification, GLIM_SESSION_LOCK, 3);
    glim_session_observe(ws, NSWorkspaceSessionDidBecomeActiveNotification, GLIM_SESSION_UNLOCK, 4);
    glim_session_observe(ws, NSWorkspaceWillSleepNotification, GLIM_SESSION_SLEEP, 5);
    glim_session_observe(ws, NSWorkspaceDidWakeNotification, GLIM_SESSION_WAKE, 6);
    glim_session_observe(ws, NSWorkspaceScreensDidSleepNotification, GLIM_SESSION_SLEEP, 7);
    glim_session_observe(ws, NSWorkspaceScreensDidWakeNotification, GLIM_SESSION_WAKE, 8);
    id token = [dist addObserverForName:kGlimSessionTest
                                 object:nil
                                  queue:nil
                             usingBlock:^(NSNotification *note) {
                               id obj = note.object;
                               int32_t kind = [obj isKindOfClass:[NSString class]] ? (int32_t)[(NSString *)obj intValue] : 0;
                               if (kind >= GLIM_SESSION_LOCK && kind <= GLIM_SESSION_WAKE) glim_session_emit(kind, 99);
                             }];
    [g_session_tokens addObject:@[ dist, token ]];
  } else {
    for (NSArray *pair in g_session_tokens) {
      [(NSNotificationCenter *)pair[0] removeObserver:pair[1]];
    }
    g_session_tokens = nil;
    g_session_observers = 0;
    g_session_cb = NULL;
  }
}

static int32_t glim_session_on_main(glim_session_call *c) {
  if (pthread_main_np()) {
    glim_session_do(c);
  } else {
    dispatch_sync_f(dispatch_get_main_queue(), c, glim_session_do);
  }
  return c->status;
}

// Start observing; `cb` gets (kind, source) for every notification. Calling it again
// replaces the callback.
GLIM_EXPORT int32_t glim_session_start(glim_session_cb cb) {
  if (!cb) {
    glim_set_error("null session callback");
    return GLIM_E_ARGS;
  }
  g_session_cb = cb;
  glim_session_call c = {0, GLIM_E_API};
  @autoreleasepool {
    return glim_session_on_main(&c);
  }
}

// Remove every observer (call before closing the JSCallback).
GLIM_EXPORT int32_t glim_session_stop(void) {
  glim_session_call c = {1, GLIM_E_API};
  @autoreleasepool {
    return glim_session_on_main(&c);
  }
}

// Smoke tests: post the Glimpse test notification for `kind` through the distributed
// notification center (the same delivery path as com.apple.screenIsLocked).
GLIM_EXPORT int32_t glim_session_simulate(int32_t kind) {
  if (kind < GLIM_SESSION_LOCK || kind > GLIM_SESSION_WAKE) {
    glim_set_error("bad session kind %d", kind);
    return GLIM_E_ARGS;
  }
  @autoreleasepool {
    [[NSDistributedNotificationCenter defaultCenter] postNotificationName:kGlimSessionTest
                                                                   object:[NSString stringWithFormat:@"%d", kind]
                                                                 userInfo:nil
                                                       deliverImmediately:YES];
  }
  return GLIM_OK;
}

// Smoke tests only: run the calling thread's run loop for `ms` (must be the main thread,
// which Electrobun runs anyway). Returns GLIM_E_UNSUPPORTED off the main thread.
GLIM_EXPORT int32_t glim_session_pump(int32_t ms) {
  if (!pthread_main_np()) {
    glim_set_error("glim_session_pump must run on the main thread");
    return GLIM_E_UNSUPPORTED;
  }
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, (CFTimeInterval)(ms > 0 ? ms : 0) / 1000.0, false);
  return GLIM_OK;
}

// {"running":0|1,"observers":N}
GLIM_EXPORT int32_t glim_session_info(char *buf, int32_t cap) {
  char out[96];
  snprintf(out, sizeof out, "{\"running\":%d,\"observers\":%d}", g_session_cb ? 1 : 0, (int)g_session_observers);
  return glim_copy_out(out, buf, cap);
}
