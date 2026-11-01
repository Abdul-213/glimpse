// ScreenCaptureKit capture for libglimpse.dylib, with Glimpse's own windows excluded.
// Ported from spikes/capture/native/macos/GlimCapture.swift (shot + stream) and
// spikes/capture-exclusion/native/macos/glimcapture.m (exclusion filter).
//
//   glim_capture_shot     one-shot SCScreenshotManager capture (Snip). macOS 14+.
//   glim_capture_stream_* a persistent SCStream per display piece (Live). Only the newest
//                         complete frame is kept; idle frames (screen unchanged) keep
//                         the sequence number still.
//
// Exclusion: every filter excludes this process's SCRunningApplication when SCK lists it
// (covers every Glimpse window, including ones created later). Otherwise it excludes, by
// SCWindow, every window owned by this pid plus the ids passed to
// glim_capture_set_excluded_windows. This doesn't depend on NSWindow.sharingType, which
// ScreenCaptureKit ignores on macOS 15+ (spikes/capture-exclusion/FINDINGS.md).
//
// Coordinates: display-local points for the source rect, output size in pixels. SCK
// scales; with captureResolution = best a Retina display gives native detail.
#import <Accelerate/Accelerate.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <os/lock.h>
#include <unistd.h>

#include "glimpse.h"

static const double kContentTimeout = 5.0;
static const double kShotTimeout = 3.0;
static const double kStartTimeout = 5.0;
static const double kStopTimeout = 2.0;
static const double kFirstFrameTimeout = 1.0;

// ---- helpers -------------------------------------------------------------

static BOOL glim_wait(dispatch_semaphore_t sem, double seconds) {
  return dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC))) == 0;
}

// NSError -> status. ScreenCaptureKit errors keep their (negative) SCStreamErrorCode.
static int32_t glim_status_for(NSError *e, const char *what) {
  glim_set_error("%s: %s (%s %ld)", what, e.localizedDescription.UTF8String ?: "unknown error",
                 e.domain.UTF8String ?: "?", (long)e.code);
  if (!e || e.code == 0) return GLIM_E_API;
  return (int32_t)e.code;
}

// BGRA CVPixelBuffer -> RGBA sub-rect of `out`, alpha forced to 255.
static int32_t glim_blit(CVPixelBufferRef pb, uint8_t *out, int32_t stride, int32_t dx, int32_t dy, int32_t dw,
                         int32_t dh) {
  if (CVPixelBufferGetPixelFormatType(pb) != kCVPixelFormatType_32BGRA) {
    glim_set_error("unexpected pixel format %u", (unsigned)CVPixelBufferGetPixelFormatType(pb));
    return GLIM_E_UNSUPPORTED;
  }
  CVPixelBufferLockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
  void *base = CVPixelBufferGetBaseAddress(pb);
  if (!base) {
    CVPixelBufferUnlockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
    glim_set_error("pixel buffer has no base address");
    return GLIM_E_API;
  }
  size_t w = MIN((size_t)dw, CVPixelBufferGetWidth(pb));
  size_t h = MIN((size_t)dh, CVPixelBufferGetHeight(pb));
  vImage_Buffer src = {base, h, w, CVPixelBufferGetBytesPerRow(pb)};
  vImage_Buffer dst = {out + (size_t)dy * stride + (size_t)dx * 4, h, w, (size_t)stride};
  const uint8_t map[4] = {2, 1, 0, 3};  // BGRA -> RGBA
  vImage_Error err = vImagePermuteChannels_ARGB8888(&src, &dst, map, kvImageNoFlags);
  // Mask 0x1 selects the 4th byte of each pixel: alpha in RGBA order.
  if (err == kvImageNoError) err = vImageOverwriteChannelsWithScalar_ARGB8888(255, &dst, &dst, 0x1, kvImageNoFlags);
  CVPixelBufferUnlockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
  if (err != kvImageNoError) {
    glim_set_error("vImage error %ld", (long)err);
    return GLIM_E_API;
  }
  return GLIM_OK;
}

static BOOL glim_dest_ok(const int32_t *dest, int32_t stride, uint64_t len) {
  if (!dest) return NO;
  int32_t dx = dest[0], dy = dest[1], dw = dest[2], dh = dest[3];
  return dw > 0 && dh > 0 && dx >= 0 && dy >= 0 && stride >= (dx + dw) * 4 &&
         (uint64_t)stride * (uint64_t)(dy + dh) <= len;
}

static SCStreamConfiguration *glim_config(const double *src, int32_t dw, int32_t dh) {
  SCStreamConfiguration *cfg = [[SCStreamConfiguration alloc] init];
  cfg.sourceRect = CGRectMake(src[0], src[1], src[2], src[3]);  // display-local points
  cfg.width = (size_t)dw;                                       // output pixels
  cfg.height = (size_t)dh;
  cfg.pixelFormat = kCVPixelFormatType_32BGRA;
  cfg.colorSpaceName = kCGColorSpaceSRGB;
  cfg.showsCursor = NO;
  cfg.scalesToFit = YES;
  cfg.captureResolution = SCCaptureResolutionBest;
  return cfg;
}

// ---- shared state: shareable content + exclusion list -----------------------

static NSObject *glim_state_lock(void) {
  static NSObject *lock;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    lock = [NSObject new];
  });
  return lock;
}

static SCShareableContent *g_content;  // cached: fetching is slow and is what triggers TCC
static BOOL g_content_stale = YES;
static NSSet<NSNumber *> *g_excluded;

// Caller holds the state lock.
static int32_t glim_refresh_content(void) {
  __block SCShareableContent *content = nil;
  __block NSError *error = nil;
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  // Off-screen windows too: a Glimpse window that is hidden right now must still be
  // known when the filter is built for a long-running stream.
  [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                                             onScreenWindowsOnly:NO
                                               completionHandler:^(SCShareableContent *c, NSError *e) {
                                                 content = c;
                                                 error = e;
                                                 dispatch_semaphore_signal(sem);
                                               }];
  if (!glim_wait(sem, kContentTimeout)) {
    glim_set_error("SCShareableContent timed out after %.0f s", kContentTimeout);
    return GLIM_E_TIMEOUT;
  }
  if (!content) return glim_status_for(error, "SCShareableContent");
  g_content = content;
  g_content_stale = NO;
  return GLIM_OK;
}

static SCDisplay *glim_find_display(CGDirectDisplayID displayID) {
  for (SCDisplay *d in g_content.displays) {
    if (d.displayID == displayID) return d;
  }
  return nil;
}

// Caller holds the state lock. Returns nil and sets *status on failure.
static SCContentFilter *glim_filter_for(CGDirectDisplayID displayID, int32_t *status) {
  if (!g_content || g_content_stale) {
    int32_t r = glim_refresh_content();
    if (r != GLIM_OK) {
      *status = r;
      return nil;
    }
  }
  SCDisplay *display = glim_find_display(displayID);
  if (!display) {
    // Displays changed since the cached content: refetch once.
    int32_t r = glim_refresh_content();
    if (r != GLIM_OK) {
      *status = r;
      return nil;
    }
    display = glim_find_display(displayID);
  }
  if (!display) {
    glim_set_error("display %u not in SCShareableContent", displayID);
    *status = GLIM_E_NO_DISPLAY;
    return nil;
  }
  pid_t me = getpid();
  for (SCRunningApplication *app in g_content.applications) {
    if (app.processID == me) {
      return [[SCContentFilter alloc] initWithDisplay:display excludingApplications:@[ app ] exceptingWindows:@[]];
    }
  }
  NSMutableArray<SCWindow *> *windows = [NSMutableArray array];
  for (SCWindow *w in g_content.windows) {
    if (w.owningApplication.processID == me || [g_excluded containsObject:@(w.windowID)]) [windows addObject:w];
  }
  return [[SCContentFilter alloc] initWithDisplay:display excludingWindows:windows];
}

// ---- streams --------------------------------------------------------------

@interface GlimStream : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, assign) CGDirectDisplayID displayID;
@property(nonatomic, assign) int32_t width;
@property(nonatomic, assign) int32_t height;
@end

@implementation GlimStream {
  os_unfair_lock _lock;
  CVPixelBufferRef _latest;  // the newest complete frame, retained
  uint64_t _seq;
  int32_t _stopStatus;
  dispatch_queue_t _queue;
}

- (instancetype)init {
  if ((self = [super init])) {
    _lock = OS_UNFAIR_LOCK_INIT;
    _queue = dispatch_queue_create("dev.glimpse.capture.stream", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)dealloc {
  if (_latest) CVPixelBufferRelease(_latest);
}

- (dispatch_queue_t)queue {
  return _queue;
}

- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sb ofType:(SCStreamOutputType)type {
  if (type != SCStreamOutputTypeScreen) return;
  CFArrayRef atts = CMSampleBufferGetSampleAttachmentsArray(sb, false);
  if (!atts || CFArrayGetCount(atts) == 0) return;
  NSDictionary *info = (__bridge NSDictionary *)CFArrayGetValueAtIndex(atts, 0);
  NSNumber *status = info[SCStreamFrameInfoStatus];
  // Idle frames carry no pixels: the screen didn't change, keep the last frame.
  if (!status || status.integerValue != SCFrameStatusComplete) return;
  CVPixelBufferRef pb = CMSampleBufferGetImageBuffer(sb);
  if (!pb) return;
  CVPixelBufferRetain(pb);
  os_unfair_lock_lock(&_lock);
  CVPixelBufferRef old = _latest;
  _latest = pb;  // keep one buffer only, so the stream's pool never runs dry
  _seq++;
  os_unfair_lock_unlock(&_lock);
  if (old) CVPixelBufferRelease(old);
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  os_unfair_lock_lock(&_lock);
  _stopStatus = error.code != 0 ? (int32_t)error.code : GLIM_E_API;
  os_unfair_lock_unlock(&_lock);
}

// Copies the latest frame (retained) and its sequence; returns the stop status or 0.
- (int32_t)latest:(CVPixelBufferRef *)pbOut seq:(uint64_t *)seqOut {
  os_unfair_lock_lock(&_lock);
  CVPixelBufferRef pb = _latest;
  if (pb) CVPixelBufferRetain(pb);
  *pbOut = pb;
  *seqOut = _seq;
  int32_t stop = _stopStatus;
  os_unfair_lock_unlock(&_lock);
  return stop;
}

- (void)stop {
  SCStream *s = self.stream;
  self.stream = nil;
  if (!s) return;
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  [s stopCaptureWithCompletionHandler:^(NSError *e) {
    dispatch_semaphore_signal(sem);
  }];
  glim_wait(sem, kStopTimeout);
}
@end

static NSMutableDictionary<NSNumber *, GlimStream *> *glim_streams(void) {
  static NSMutableDictionary *streams;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    streams = [NSMutableDictionary dictionary];
  });
  return streams;
}
static uint64_t g_next_handle = 1;

// ---- C ABI ----------------------------------------------------------------

// The CGWindowIDs of every open Glimpse window. Running streams get an updated filter.
GLIM_EXPORT int32_t glim_capture_set_excluded_windows(const uint32_t *ids, int32_t count) {
  if (count < 0 || (count > 0 && !ids)) {
    glim_set_error("bad window id list");
    return GLIM_E_ARGS;
  }
  @autoreleasepool {
    @synchronized(glim_state_lock()) {
      NSMutableSet *set = [NSMutableSet setWithCapacity:(NSUInteger)count];
      for (int32_t i = 0; i < count; i++) [set addObject:@(ids[i])];
      g_excluded = set;
      g_content_stale = YES;
      NSArray<GlimStream *> *streams = glim_streams().allValues;
      if (streams.count == 0) return GLIM_OK;
      int32_t result = GLIM_OK;
      for (GlimStream *gs in streams) {
        int32_t status = GLIM_OK;
        SCContentFilter *filter = glim_filter_for(gs.displayID, &status);
        if (!filter) {
          result = status;
          continue;
        }
        __block NSError *error = nil;
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        [gs.stream updateContentFilter:filter
                     completionHandler:^(NSError *e) {
                       error = e;
                       dispatch_semaphore_signal(sem);
                     }];
        if (!glim_wait(sem, kStopTimeout)) {
          glim_set_error("SCStream updateContentFilter timed out");
          result = GLIM_E_TIMEOUT;
        } else if (error) {
          result = glim_status_for(error, "SCStream updateContentFilter");
        }
      }
      return result;
    }
  }
}

// One-shot capture of src = {x, y, width, height} (display-local points) on displayID
// into dest = {x, y, width, height} (pixels) of `out`.
GLIM_EXPORT int32_t glim_capture_shot(uint32_t displayID, const double *src, const int32_t *dest, uint8_t *out,
                                      int32_t stride, uint64_t len) {
  if (!src || !out || !glim_dest_ok(dest, stride, len) || !(src[2] > 0) || !(src[3] > 0)) {
    glim_set_error("bad geometry or output buffer");
    return GLIM_E_ARGS;
  }
  @autoreleasepool {
    SCContentFilter *filter = nil;
    int32_t status = GLIM_OK;
    @synchronized(glim_state_lock()) {
      filter = glim_filter_for(displayID, &status);
    }
    if (!filter) return status;
    SCStreamConfiguration *cfg = glim_config(src, dest[2], dest[3]);
    __block CMSampleBufferRef sample = NULL;
    __block NSError *error = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [SCScreenshotManager captureSampleBufferWithFilter:filter
                                         configuration:cfg
                                     completionHandler:^(CMSampleBufferRef sb, NSError *e) {
                                       if (sb) sample = (CMSampleBufferRef)CFRetain(sb);
                                       error = e;
                                       dispatch_semaphore_signal(sem);
                                     }];
    if (!glim_wait(sem, kShotTimeout)) {
      // The handler may still run later; it only touches the __block storage, which
      // outlives this frame. The late sample buffer leaks (rare, small).
      glim_set_error("SCScreenshotManager timed out after %.0f s", kShotTimeout);
      return GLIM_E_TIMEOUT;
    }
    if (!sample) return glim_status_for(error, "SCScreenshotManager");
    CVPixelBufferRef pb = CMSampleBufferGetImageBuffer(sample);
    int32_t r = pb ? glim_blit(pb, out, stride, dest[0], dest[1], dest[2], dest[3]) : GLIM_E_NO_FRAME;
    if (!pb) glim_set_error("SCScreenshotManager returned no image buffer");
    CFRelease(sample);
    return r;
  }
}

// Start a stream over src (display-local points) producing width x height px frames at
// most `fps` per second. Writes a handle for stream_read / stream_close.
GLIM_EXPORT int32_t glim_capture_stream_open(uint32_t displayID, const double *src, int32_t width, int32_t height,
                                             int32_t fps, uint64_t *handleOut) {
  if (!src || !handleOut || width <= 0 || height <= 0 || fps <= 0 || !(src[2] > 0) || !(src[3] > 0)) {
    glim_set_error("bad stream parameters");
    return GLIM_E_ARGS;
  }
  @autoreleasepool {
    SCContentFilter *filter = nil;
    int32_t status = GLIM_OK;
    @synchronized(glim_state_lock()) {
      filter = glim_filter_for(displayID, &status);
    }
    if (!filter) return status;
    SCStreamConfiguration *cfg = glim_config(src, width, height);
    cfg.minimumFrameInterval = CMTimeMake(1, fps);
    cfg.queueDepth = 3;
    GlimStream *gs = [[GlimStream alloc] init];
    gs.displayID = displayID;
    gs.width = width;
    gs.height = height;
    SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:cfg delegate:gs];
    NSError *addError = nil;
    if (![stream addStreamOutput:gs type:SCStreamOutputTypeScreen sampleHandlerQueue:gs.queue error:&addError]) {
      return glim_status_for(addError, "SCStream addStreamOutput");
    }
    __block NSError *error = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [stream startCaptureWithCompletionHandler:^(NSError *e) {
      error = e;
      dispatch_semaphore_signal(sem);
    }];
    if (!glim_wait(sem, kStartTimeout)) {
      glim_set_error("SCStream startCapture timed out after %.0f s", kStartTimeout);
      [stream stopCaptureWithCompletionHandler:^(NSError *e){
      }];
      return GLIM_E_TIMEOUT;
    }
    if (error) return glim_status_for(error, "SCStream startCapture");
    gs.stream = stream;
    @synchronized(glim_state_lock()) {
      uint64_t handle = g_next_handle++;
      glim_streams()[@(handle)] = gs;
      *handleOut = handle;
    }
    return GLIM_OK;
  }
}

// Copy the stream's latest frame into dest of `out` (dest size must match the stream's).
// Waits up to 1 s for the first frame. *seqOut stays the same while the screen is idle.
GLIM_EXPORT int32_t glim_capture_stream_read(uint64_t handle, const int32_t *dest, uint8_t *out, int32_t stride,
                                             uint64_t len, uint64_t *seqOut) {
  if (!out || !glim_dest_ok(dest, stride, len)) {
    glim_set_error("bad destination");
    return GLIM_E_ARGS;
  }
  GlimStream *gs = nil;
  @synchronized(glim_state_lock()) {
    gs = glim_streams()[@(handle)];
  }
  if (!gs) {
    glim_set_error("unknown stream %llu", (unsigned long long)handle);
    return GLIM_E_ARGS;
  }
  if (dest[2] != gs.width || dest[3] != gs.height) {
    glim_set_error("dest %dx%d does not match stream %dx%d", dest[2], dest[3], gs.width, gs.height);
    return GLIM_E_ARGS;
  }
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:kFirstFrameTimeout];
  for (;;) {
    CVPixelBufferRef pb = NULL;
    uint64_t seq = 0;
    int32_t stop = [gs latest:&pb seq:&seq];
    if (pb) {
      int32_t r = glim_blit(pb, out, stride, dest[0], dest[1], dest[2], dest[3]);
      CVPixelBufferRelease(pb);
      if (seqOut) *seqOut = seq;
      return r;
    }
    if (stop != 0) {
      glim_set_error("SCStream stopped (%d)", stop);
      return stop;
    }
    if ([deadline timeIntervalSinceNow] < 0) {
      glim_set_error("SCStream: no frame within %.0f s", kFirstFrameTimeout);
      return GLIM_E_NO_FRAME;
    }
    usleep(2000);
  }
}

// Copy a size x size px patch with top-left (x, y) in the stream's output pixels from
// the latest frame into `out` (tightly packed RGBA, size * size * 4 bytes). Pixels
// outside the frame are opaque black. For the picker's loupe (GLIM-91): a full-display
// stream at 30 fps stays warm while the picker is open and each sample reads 900 bytes,
// instead of a ScreenCaptureKit screenshot per pointer move. Returns GLIM_E_NO_FRAME
// (without waiting) until the first frame has arrived.
GLIM_EXPORT int32_t glim_capture_stream_sample(uint64_t handle, int32_t x, int32_t y, int32_t size, uint8_t *out,
                                               uint64_t len, uint64_t *seqOut) {
  if (!out || size <= 0 || size > 64 || len < (uint64_t)size * (uint64_t)size * 4) {
    glim_set_error("bad sample size or buffer");
    return GLIM_E_ARGS;
  }
  GlimStream *gs = nil;
  @synchronized(glim_state_lock()) {
    gs = glim_streams()[@(handle)];
  }
  if (!gs) {
    glim_set_error("unknown stream %llu", (unsigned long long)handle);
    return GLIM_E_ARGS;
  }
  CVPixelBufferRef pb = NULL;
  uint64_t seq = 0;
  int32_t stop = [gs latest:&pb seq:&seq];
  if (!pb) {
    if (stop != 0) {
      glim_set_error("SCStream stopped (%d)", stop);
      return stop;
    }
    glim_set_error("SCStream: no frame yet");
    return GLIM_E_NO_FRAME;
  }
  int32_t r = GLIM_OK;
  if (CVPixelBufferGetPixelFormatType(pb) != kCVPixelFormatType_32BGRA) {
    glim_set_error("unexpected pixel format %u", (unsigned)CVPixelBufferGetPixelFormatType(pb));
    r = GLIM_E_UNSUPPORTED;
  } else {
    CVPixelBufferLockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
    const uint8_t *base = (const uint8_t *)CVPixelBufferGetBaseAddress(pb);
    size_t bpr = CVPixelBufferGetBytesPerRow(pb);
    int32_t fw = (int32_t)CVPixelBufferGetWidth(pb), fh = (int32_t)CVPixelBufferGetHeight(pb);
    for (int32_t row = 0; row < size; row++) {
      for (int32_t col = 0; col < size; col++) {
        uint8_t *d = out + ((size_t)row * (size_t)size + (size_t)col) * 4;
        int32_t sx = x + col, sy = y + row;
        if (!base || sx < 0 || sy < 0 || sx >= fw || sy >= fh) {
          d[0] = d[1] = d[2] = 0;
        } else {
          const uint8_t *s = base + (size_t)sy * bpr + (size_t)sx * 4;
          d[0] = s[2];
          d[1] = s[1];
          d[2] = s[0];
        }
        d[3] = 255;
      }
    }
    CVPixelBufferUnlockBaseAddress(pb, kCVPixelBufferLock_ReadOnly);
  }
  CVPixelBufferRelease(pb);
  if (seqOut) *seqOut = seq;
  return r;
}

GLIM_EXPORT int32_t glim_capture_stream_close(uint64_t handle) {
  GlimStream *gs = nil;
  @synchronized(glim_state_lock()) {
    gs = glim_streams()[@(handle)];
    [glim_streams() removeObjectForKey:@(handle)];
  }
  if (!gs) return GLIM_OK;
  [gs stop];
  return GLIM_OK;
}

// Stop every stream and forget the cached shareable content.
GLIM_EXPORT void glim_capture_reset(void) {
  NSArray<GlimStream *> *streams = nil;
  @synchronized(glim_state_lock()) {
    streams = glim_streams().allValues;
    [glim_streams() removeAllObjects];
    g_content = nil;
    g_content_stale = YES;
  }
  for (GlimStream *gs in streams) [gs stop];
}

// {"displays":[{"id":<CGDirectDisplayID>,"bounds":{x,y,width,height},"scale":2,"primary":true}]}
// Bounds are global points (top-left origin of the main display), the same space as
// Electrobun's Screen API; scale is backing pixels per point. Used by the harness, which
// runs without Electrobun.
GLIM_EXPORT int32_t glim_capture_displays_json(char *buf, int32_t cap) {
  @autoreleasepool {
    uint32_t count = 0;
    CGGetActiveDisplayList(0, NULL, &count);
    CGDirectDisplayID ids[32];
    if (count > 32) count = 32;
    CGGetActiveDisplayList(count, ids, &count);
    NSMutableArray *items = [NSMutableArray array];
    for (uint32_t i = 0; i < count; i++) {
      CGRect b = CGDisplayBounds(ids[i]);
      double scale = 1.0;
      CGDisplayModeRef mode = CGDisplayCopyDisplayMode(ids[i]);
      if (mode) {
        if (CGDisplayModeGetWidth(mode) > 0)
          scale = (double)CGDisplayModeGetPixelWidth(mode) / (double)CGDisplayModeGetWidth(mode);
        CGDisplayModeRelease(mode);
      }
      [items addObject:@{
        @"id" : @(ids[i]),
        @"bounds" : @{@"x" : @(b.origin.x), @"y" : @(b.origin.y), @"width" : @(b.size.width), @"height" : @(b.size.height)},
        @"scale" : @(scale),
        @"primary" : @(CGDisplayIsMain(ids[i]) != 0)
      }];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"displays" : items} options:0 error:nil];
    NSString *s = json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : @"{\"displays\":[]}";
    return glim_copy_out(s.UTF8String, buf, cap);
  }
}

// 1 if this process may capture the screen (never prompts), else 0.
GLIM_EXPORT int32_t glim_capture_preflight(void) { return CGPreflightScreenCaptureAccess() ? 1 : 0; }
