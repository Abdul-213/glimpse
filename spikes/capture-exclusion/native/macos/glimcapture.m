// GLIM-16 spike: NSWindow.sharingType + ScreenCaptureKit capture with
// SCContentFilter exclusion, loaded from Bun with bun:ffi.
//
// Same pattern as the GLIM-14 hotkey spike (native/macos/glimhotkey.c):
//   * Electrobun runs app JS on a Bun Worker thread; the main thread runs the
//     AppKit event loop. NSWindow properties must be touched on the main thread,
//     so the window functions hop there with dispatch_sync_f.
//   * ScreenCaptureKit is asynchronous (completion handlers on SCK's own
//     queues). glim_cx_capture blocks the *calling* (worker) thread on a
//     semaphore until the handlers finish, and never touches the main thread,
//     so it cannot deadlock against AppKit.
//   * Pixels go back to JS as raw sRGB RGBA8 files (one per display) so that the
//     marker analysis and PNG encoding stay in the shared, unit-tested TS code.
//
// Build (macOS 14+, Xcode Command Line Tools): `bun run native:mac`.

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <dispatch/dispatch.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

// ---- main-thread helpers ------------------------------------------------

typedef struct {
  int op;  // 0 set sharingType, 1 get sharingType, 2 windowNumber, 3 level
  void *window;
  int32_t value;
  int32_t result;
} glim_win_call;

static void glim_win_do(void *ctx) {
  glim_win_call *c = (glim_win_call *)ctx;
  NSWindow *w = (__bridge NSWindow *)c->window;
  if (!w || ![w isKindOfClass:[NSWindow class]]) {
    c->result = -1;
    return;
  }
  switch (c->op) {
    case 0:
      w.sharingType = (NSWindowSharingType)c->value;
      c->result = (int32_t)w.sharingType;
      break;
    case 1:
      c->result = (int32_t)w.sharingType;
      break;
    case 2:
      c->result = (int32_t)w.windowNumber;
      break;
    case 3:
      c->result = (int32_t)w.level;
      break;
    default:
      c->result = -2;
  }
}

static int32_t glim_win_on_main(glim_win_call *c) {
  if (pthread_main_np()) {
    glim_win_do(c);
  } else {
    dispatch_sync_f(dispatch_get_main_queue(), c, glim_win_do);
  }
  return c->result;
}

// Sets NSWindow.sharingType (0 none, 1 readOnly, 2 readWrite). Returns the value
// read back, or -1 if `window` is not an NSWindow.
int32_t glim_cx_set_sharing(void *window, int32_t type) {
  glim_win_call c = {0, window, type, 0};
  return glim_win_on_main(&c);
}

int32_t glim_cx_get_sharing(void *window) {
  glim_win_call c = {1, window, 0, 0};
  return glim_win_on_main(&c);
}

// NSWindow.windowNumber == CGWindowID == SCWindow.windowID.
int32_t glim_cx_window_number(void *window) {
  glim_win_call c = {2, window, 0, 0};
  return glim_win_on_main(&c);
}

int32_t glim_cx_window_level(void *window) {
  glim_win_call c = {3, window, 0, 0};
  return glim_win_on_main(&c);
}

// ---- permission + version ----------------------------------------------

int32_t glim_cx_preflight(void) { return CGPreflightScreenCaptureAccess() ? 1 : 0; }

int32_t glim_cx_request(void) { return CGRequestScreenCaptureAccess() ? 1 : 0; }

int32_t glim_cx_os_version(char *buf, int32_t len) {
  if (!buf || len <= 0) return -1;
  NSOperatingSystemVersion v = [[NSProcessInfo processInfo] operatingSystemVersion];
  snprintf(buf, (size_t)len, "%ld.%ld.%ld", (long)v.majorVersion, (long)v.minorVersion,
           (long)v.patchVersion);
  return 0;
}

// ---- ScreenCaptureKit capture -------------------------------------------

static int32_t glim_write_json(NSDictionary *dict, char *out, int32_t outLen) {
  NSError *err = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:dict options:0 error:&err];
  if (!data) {
    snprintf(out, (size_t)outLen, "{\"ok\":false,\"error\":\"json: %s\"}",
             err.localizedDescription.UTF8String ?: "?");
    return -10;
  }
  if ((int32_t)data.length >= outLen) {
    snprintf(out, (size_t)outLen, "{\"ok\":false,\"error\":\"json buffer too small (%lu)\"}",
             (unsigned long)data.length);
    return -11;
  }
  memcpy(out, data.bytes, data.length);
  out[data.length] = 0;
  return 0;
}

static NSDictionary *glim_rect(CGRect r) {
  return @{
    @"x" : @(r.origin.x),
    @"y" : @(r.origin.y),
    @"width" : @(r.size.width),
    @"height" : @(r.size.height)
  };
}

// Draw a CGImage into a tightly packed sRGB RGBA8 buffer and write it to `path`.
static BOOL glim_write_rgba(CGImageRef image, NSString *path, size_t *w, size_t *h) {
  size_t width = CGImageGetWidth(image);
  size_t height = CGImageGetHeight(image);
  size_t stride = width * 4;
  uint8_t *px = calloc(height, stride);
  if (!px) return NO;
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef ctx = CGBitmapContextCreate(px, width, height, 8, stride, cs,
                                           (CGBitmapInfo)(kCGBitmapByteOrder32Big |
                                                          kCGImageAlphaPremultipliedLast));
  CGColorSpaceRelease(cs);
  if (!ctx) {
    free(px);
    return NO;
  }
  // CGBitmapContext memory is already top row first for a plain draw.
  CGContextSetBlendMode(ctx, kCGBlendModeCopy);
  CGContextDrawImage(ctx, CGRectMake(0, 0, (CGFloat)width, (CGFloat)height), image);
  CGContextRelease(ctx);
  for (size_t i = 3; i < height * stride; i += 4) px[i] = 0xff;
  FILE *f = fopen(path.fileSystemRepresentation, "wb");
  BOOL ok = NO;
  if (f) {
    ok = fwrite(px, 1, height * stride, f) == height * stride;
    fclose(f);
  }
  free(px);
  *w = width;
  *h = height;
  return ok;
}

// mode: 0 = no exclusion, 1 = excludingApplications:[this process],
//       2 = excludingWindows:[SCWindow with windowID == excludeWindowId].
// outPrefix: path prefix; writes "<outPrefix>-d<index>.rgba" per display.
// jsonOut receives a JSON report (see glimcapture.ts). Returns 0 on success.
int32_t glim_cx_capture(int32_t mode, uint32_t excludeWindowId, const char *outPrefix,
                        char *jsonOut, int32_t jsonLen) {
  @autoreleasepool {
    // SCScreenshotManager, contentRect and pointPixelScale need macOS 14, which
    // is also Electrobun's minimum (the dylib is built with -mmacosx-version-min=14.0).
    if (!jsonOut || jsonLen < 128 || !outPrefix) return -1;
    NSString *prefix = [NSString stringWithUTF8String:outPrefix];
    double t0 = CFAbsoluteTimeGetCurrent();

    __block SCShareableContent *content = nil;
    __block NSError *contentErr = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [SCShareableContent
        getShareableContentExcludingDesktopWindows:NO
                               onScreenWindowsOnly:YES
                                 completionHandler:^(SCShareableContent *c, NSError *e) {
                                   content = c;
                                   contentErr = e;
                                   dispatch_semaphore_signal(sem);
                                 }];
    if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) != 0) {
      return glim_write_json(@{@"ok" : @NO, @"error" : @"SCShareableContent timed out"}, jsonOut,
                             jsonLen) ?: -3;
    }
    if (!content) {
      NSString *msg = [NSString
          stringWithFormat:@"SCShareableContent failed: %@ (code %ld). Screen Recording permission?",
                           contentErr.localizedDescription ?: @"nil", (long)contentErr.code];
      return glim_write_json(@{@"ok" : @NO, @"error" : msg}, jsonOut, jsonLen) ?: -4;
    }

    pid_t me = getpid();
    SCRunningApplication *ownApp = nil;
    for (SCRunningApplication *app in content.applications) {
      if (app.processID == me) {
        ownApp = app;
        break;
      }
    }
    NSMutableArray *ownWindows = [NSMutableArray array];
    SCWindow *excluded = nil;
    for (SCWindow *w in content.windows) {
      if (w.owningApplication.processID == me) {
        [ownWindows addObject:@{
          @"windowID" : @(w.windowID),
          @"title" : w.title ?: @"",
          @"onScreen" : @(w.onScreen),
          @"layer" : @(w.windowLayer),
          @"frame" : glim_rect(w.frame)
        }];
      }
      if (w.windowID == excludeWindowId) excluded = w;
    }

    NSMutableArray *displays = [NSMutableArray array];
    NSMutableArray *errors = [NSMutableArray array];
    NSUInteger index = 0;
    for (SCDisplay *display in content.displays) {
      SCContentFilter *filter = nil;
      if (mode == 1) {
        filter = [[SCContentFilter alloc] initWithDisplay:display
                                    excludingApplications:(ownApp ? @[ ownApp ] : @[])
                                         exceptingWindows:@[]];
      } else if (mode == 2) {
        filter = [[SCContentFilter alloc] initWithDisplay:display
                                         excludingWindows:(excluded ? @[ excluded ] : @[])];
      } else {
        filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
      }
      SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
      CGRect rect = filter.contentRect;
      CGFloat scale = filter.pointPixelScale;
      config.width = (size_t)(rect.size.width * scale);
      config.height = (size_t)(rect.size.height * scale);
      config.showsCursor = NO;
      config.captureResolution = SCCaptureResolutionBest;

      __block CGImageRef image = NULL;
      __block NSError *capErr = nil;
      dispatch_semaphore_t done = dispatch_semaphore_create(0);
      double c0 = CFAbsoluteTimeGetCurrent();
      [SCScreenshotManager captureImageWithFilter:filter
                                    configuration:config
                                completionHandler:^(CGImageRef img, NSError *e) {
                                  if (img) image = CGImageRetain(img);
                                  capErr = e;
                                  dispatch_semaphore_signal(done);
                                }];
      if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) != 0) {
        [errors addObject:[NSString stringWithFormat:@"display %u: capture timed out",
                                                     display.displayID]];
        index++;
        continue;
      }
      double ms = (CFAbsoluteTimeGetCurrent() - c0) * 1000.0;
      if (!image) {
        [errors addObject:[NSString stringWithFormat:@"display %u: %@", display.displayID,
                                                     capErr.localizedDescription ?: @"no image"]];
        index++;
        continue;
      }
      NSString *path = [NSString stringWithFormat:@"%@-d%lu.rgba", prefix, (unsigned long)index];
      size_t w = 0, h = 0;
      BOOL ok = glim_write_rgba(image, path, &w, &h);
      CGImageRelease(image);
      if (!ok) {
        [errors addObject:[NSString stringWithFormat:@"display %u: write failed", display.displayID]];
      } else {
        [displays addObject:@{
          @"displayID" : @(display.displayID),
          @"file" : path,
          @"width" : @(w),
          @"height" : @(h),
          @"scale" : @(scale),
          @"frame" : glim_rect(display.frame),
          @"ms" : @(ms)
        }];
      }
      index++;
    }

    NSDictionary *report = @{
      @"ok" : @(displays.count > 0),
      @"mode" : @(mode),
      @"pid" : @(me),
      @"ownAppFound" : @(ownApp != nil),
      @"ownBundleID" : ownApp.bundleIdentifier ?: @"",
      @"excludeWindowId" : @(excludeWindowId),
      @"excludedWindowFound" : @(excluded != nil),
      @"ownWindows" : ownWindows,
      @"displays" : displays,
      @"errors" : errors,
      @"totalMs" : @((CFAbsoluteTimeGetCurrent() - t0) * 1000.0)
    };
    return glim_write_json(report, jsonOut, jsonLen);
  }
}
