// Screen-reader announcements for Live changes (GLIM-92, live-popup.md §10).
//
// The Live popup is usually not focused (a game is), and VoiceOver reads a webview's
// aria-live region only while that window has focus. So Bun also posts the coalesced change
// text as an accessibility announcement:
//   NSAccessibilityPostNotificationWithUserInfo(NSApp, NSAccessibilityAnnouncementRequestedNotification,
//     { announcement, priority })
// VoiceOver queues announcements from background apps. Unverified on hardware (GLIM-87).
#import <AppKit/AppKit.h>
#include <dispatch/dispatch.h>

#include "glimpse.h"

// Announce `utf8` (priority 0 low, 1 medium, 2 high). `window` is unused on macOS (posted on
// NSApp). Asynchronous: returns once queued on the main thread.
GLIM_EXPORT int32_t glim_announce(void *window, const char *utf8, int32_t priority) {
  if (!utf8) {
    glim_set_error("null text");
    return GLIM_E_ARGS;
  }
  NSString *text = [NSString stringWithUTF8String:utf8];
  if (!text || text.length == 0) return GLIM_OK;
  NSAccessibilityPriorityLevel level = priority >= 2   ? NSAccessibilityPriorityHigh
                                       : priority <= 0 ? NSAccessibilityPriorityLow
                                                       : NSAccessibilityPriorityMedium;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!NSApp) return;
    NSAccessibilityPostNotificationWithUserInfo(NSApp, NSAccessibilityAnnouncementRequestedNotification,
                                                @{NSAccessibilityAnnouncementKey : text,
                                                  NSAccessibilityPriorityKey : @(level)});
  });
  return GLIM_OK;
}

// *activeOut = 1 when VoiceOver is running (NSWorkspace.voiceOverEnabled).
GLIM_EXPORT int32_t glim_screen_reader_active(int32_t *activeOut) {
  if (!activeOut) return GLIM_E_ARGS;
  *activeOut = NSWorkspace.sharedWorkspace.voiceOverEnabled ? 1 : 0;
  return GLIM_OK;
}
