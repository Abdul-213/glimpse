// Pinned-region frame for Live (GLIM-90, docs/design/specs/live-popup.md 2.4 and 12.2).
//
// A click-through, always-on-top, capture-excluded panel around the pinned region that draws
// the corner ticks, the region tag and the linked-block highlight. Electrobun has no
// click-through windows, so it is a borderless non-activating NSPanel owned by the helper:
//
//   ignoresMouseEvents = YES, opaque = NO, clear background, no shadow, level 101,
//   CanJoinAllSpaces | Stationary | IgnoresCycle | FullScreenAuxiliary, sharingType = none
//
// Glimpse's own ScreenCaptureKit filter excludes the whole app (capture.m), which covers this
// panel; the binding also registers its window number for the by-window fallback.
//
// A layer-hosting view (geometryFlipped, so layers use top-left coordinates) holds CAShapeLayers
// for the halo and the ticks, the highlight, and a CALayer + CATextLayer chip for the tag.
// Coordinates in: global logical POINTS, top-left origin (Electrobun's space); converted to
// Cocoa's bottom-left space with the primary screen's height.
//
// Layout (points), mirrored by pinnedFrameLayout() in app/src/bun/services/live/frame-layout.ts:
//   window = region + 16 on every side, 40 on the tag's side when a tag shows
//   ticks: L-shapes, arm 12, stroke 2, 1 pt outside the region; 1 pt halo around them
//   tag: 20 high, 6 pt side padding, 4 pt above the top-left tick (or below the bottom-left)
//   highlight: linked-fill rounded rect (radius 3) with 1 pt stroke + 1 pt halo
//
// GLIM-154: sprites. The Live view rasterises the numbered badges and overlay cards
// (live-popup.md §2.6) and glim_frame_set_sprites hands them over as premultiplied RGBA
// bitmaps with a global rect each; they sit above the ticks, one CALayer per sprite. The panel
// stays click-through except over "interactive" sprites (badges, cards): while it has any, a
// 30 Hz timer reads the pointer and turns ignoresMouseEvents off only while the pointer is over
// one, so a click there picks the block (glim_frame_pointer) and every other click reaches the
// game. A hovered "peek" sprite (a card) drops to the peek opacity so the source shows.
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <dispatch/dispatch.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>

#include "glimpse.h"

static const CGFloat kMargin = 16, kTagMargin = 40, kArm = 12, kStroke = 2, kGap = 1, kHalo = 1;
static const CGFloat kTagH = 20, kTagPad = 6, kTagGap = 4, kRadiusBox = 3, kRadiusTag = 4, kFontPt = 12;
static const NSWindowLevel kFrameLevel = 101;  // the Live popup's level (live-popup.md 12.1)

enum { kAccent, kHaloC, kStrokeC, kHud, kHudText, kLinkedFill, kEgress, kPaletteSize };

static CGColorRef glim_color(uint32_t rgba, CGFloat opacity) {
  CGFloat c[4] = {((rgba >> 24) & 0xFF) / 255.0, ((rgba >> 16) & 0xFF) / 255.0, ((rgba >> 8) & 0xFF) / 255.0,
                  (rgba & 0xFF) / 255.0 * opacity};
  CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGColorRef color = CGColorCreate(space, c);
  CGColorSpaceRelease(space);
  return color;  // caller releases
}

enum { kSpriteInteractive = 1, kSpritePeek = 2 };

@interface GlimSprite : NSObject
@property(nonatomic) CGRect rect;  // global points, top-left origin
@property(nonatomic) CGFloat opacity;
@property(nonatomic) int flags;
@property(nonatomic, strong) CALayer *layer;
@end
@implementation GlimSprite
@end

@class GlimFrame;

@interface GlimFrameView : NSView
@property(nonatomic, weak) GlimFrame *owner;
@end

@interface GlimFrame : NSObject {
 @public
  uint32_t palette[kPaletteSize];
}
@property(nonatomic, strong) NSMutableArray<GlimSprite *> *sprites;
@property(nonatomic) CGFloat peekOpacity;
@property(nonatomic) int hover;  // index into sprites, -1 none
@property(nonatomic) int click;  // last clicked sprite since glim_frame_pointer, -1 none
@property(nonatomic, strong) NSTimer *tracker;
@property(nonatomic, strong) NSPanel *panel;
@property(nonatomic, strong) CAShapeLayer *halo;
@property(nonatomic, strong) CAShapeLayer *ticks;
@property(nonatomic, strong) CAShapeLayer *highlightHalo;
@property(nonatomic, strong) CAShapeLayer *highlight;
@property(nonatomic, strong) CALayer *tagChip;
@property(nonatomic, strong) CATextLayer *tagText;
@property(nonatomic) CGRect region;  // global points, top-left origin
@property(nonatomic) int style;
@property(nonatomic) int tag;
@property(nonatomic, copy) NSString *tagString;
@property(nonatomic) BOOL tagBelow;
@property(nonatomic) BOOL hasHighlight;
@property(nonatomic) CGRect highlightRect;  // global points
@end

@implementation GlimFrame
@end

@implementation GlimFrameView
- (BOOL)isFlipped {
  return YES;
}
- (NSView *)hitTest:(NSPoint)point {
  // Only reached while the pointer is over an interactive sprite (the panel ignores mouse
  // events otherwise); never anywhere else.
  GlimFrame *f = self.owner;
  return f && f.hover >= 0 ? self : nil;
}
- (BOOL)acceptsFirstMouse:(NSEvent *)event {
  return YES;  // the first click on a badge picks it; the panel never activates Glimpse
}
- (void)mouseDown:(NSEvent *)event {
  GlimFrame *f = self.owner;
  if (f && f.hover >= 0) f.click = f.hover;
}
@end

static NSMutableDictionary<NSNumber *, GlimFrame *> *g_frames;
static uint64_t g_nextFrame = 1;

static CGFloat glim_primary_height(void) {
  NSArray<NSScreen *> *screens = NSScreen.screens;
  return screens.count > 0 ? screens[0].frame.size.height : 0;
}

static void glim_frame_layout(GlimFrame *f) {
  CGRect r = f.region;
  if (r.size.width <= 0 || r.size.height <= 0) return;
  CGFloat top = (f.tag && !f.tagBelow) ? kTagMargin : kMargin;
  CGFloat bottom = (f.tag && f.tagBelow) ? kTagMargin : kMargin;
  CGRect win = CGRectMake(r.origin.x - kMargin, r.origin.y - top, r.size.width + 2 * kMargin,
                          r.size.height + top + bottom);
  // Global top-left -> Cocoa bottom-left.
  NSRect cocoa = NSMakeRect(win.origin.x, glim_primary_height() - (win.origin.y + win.size.height), win.size.width,
                            win.size.height);
  [f.panel setFrame:cocoa display:NO];

  CGFloat rx = kMargin, ry = top, rw = r.size.width, rh = r.size.height;
  CGFloat off = kGap + kStroke;
  CGFloat L = rx - off, T = ry - off, R = rx + rw + off, B = ry + rh + off;
  CGMutablePathRef ticks = CGPathCreateMutable();
  CGMutablePathRef halo = CGPathCreateMutable();
  void (^tick)(CGFloat, CGFloat, int, int) = ^(CGFloat ox, CGFloat oy, int dx, int dy) {
    CGFloat hx = dx > 0 ? ox : ox - kArm, vy = dy > 0 ? oy : oy - kArm;
    CGFloat hy = dy > 0 ? oy : oy - kStroke, vx = dx > 0 ? ox : ox - kStroke;
    CGRect h = CGRectMake(hx, hy, kArm, kStroke), v = CGRectMake(vx, vy, kStroke, kArm);
    CGPathAddRect(ticks, NULL, h);
    CGPathAddRect(ticks, NULL, v);
    CGPathAddRect(halo, NULL, CGRectInset(h, -kHalo, -kHalo));
    CGPathAddRect(halo, NULL, CGRectInset(v, -kHalo, -kHalo));
  };
  tick(L, T, +1, +1);
  tick(R, T, -1, +1);
  tick(L, B, +1, -1);
  tick(R, B, -1, -1);
  [CATransaction begin];
  [CATransaction setDisableActions:YES];  // colour and geometry swap instantly (spec 9)
  f.ticks.path = ticks;
  f.halo.path = halo;
  f.halo.fillRule = kCAFillRuleNonZero;
  CGColorRef tickColor = f.style == 0 ? glim_color(f->palette[kAccent], 1) : glim_color(f->palette[kStrokeC], 0.6);
  CGColorRef haloColor = glim_color(f->palette[kHaloC], 1);
  f.ticks.fillColor = tickColor;
  f.halo.fillColor = haloColor;
  CGColorRelease(tickColor);
  CGColorRelease(haloColor);
  CGPathRelease(ticks);
  CGPathRelease(halo);

  // Linked block.
  if (f.hasHighlight) {
    CGRect h = CGRectOffset(f.highlightRect, -win.origin.x, -win.origin.y);
    // CGPathCreateWithRoundedRect asserts if a radius exceeds half a side (tiny boxes).
    CGFloat rad = fmin(kRadiusBox, fmin(h.size.width, h.size.height) / 2);
    CGPathRef fill = CGPathCreateWithRoundedRect(h, rad, rad, NULL);
    CGRect outer = CGRectInset(h, -2 * kHalo, -2 * kHalo);
    CGPathRef ring = CGPathCreateWithRoundedRect(outer, rad + 2 * kHalo, rad + 2 * kHalo, NULL);
    f.highlight.path = fill;
    CGColorRef fillColor = glim_color(f->palette[kLinkedFill], 1);
    CGColorRef strokeColor = glim_color(f->palette[kStrokeC], 1);
    CGColorRef ringColor = glim_color(f->palette[kHaloC], 1);
    f.highlight.fillColor = fillColor;
    f.highlight.strokeColor = strokeColor;
    f.highlight.lineWidth = 2 * kHalo;  // half of it falls inside the box, half outside: 1 pt each
    f.highlightHalo.path = ring;
    f.highlightHalo.fillColor = ringColor;
    CGColorRelease(fillColor);
    CGColorRelease(strokeColor);
    CGColorRelease(ringColor);
    CGPathRelease(fill);
    CGPathRelease(ring);
    f.highlight.hidden = NO;
    f.highlightHalo.hidden = NO;
  } else {
    f.highlight.hidden = YES;
    f.highlightHalo.hidden = YES;
  }

  // Region tag.
  if (f.tag != 0 && f.tagString.length > 0) {
    NSFont *font = [NSFont systemFontOfSize:kFontPt weight:NSFontWeightMedium];
    CGFloat textW = ceil([f.tagString sizeWithAttributes:@{NSFontAttributeName : font}].width);
    CGFloat chipW = textW + 2 * kTagPad;
    CGFloat cx = rx - off;
    CGFloat cy = f.tagBelow ? ry + rh + off + kTagGap : ry - off - kTagGap - kTagH;
    f.tagChip.frame = CGRectMake(cx, cy, chipW, kTagH);
    CGColorRef hud = glim_color(f->palette[kHud], 1);
    f.tagChip.backgroundColor = hud;
    CGColorRelease(hud);
    f.tagChip.cornerRadius = kRadiusTag;
    f.tagText.string = f.tagString;
    f.tagText.font = (__bridge CFTypeRef)font;
    f.tagText.fontSize = kFontPt;
    CGColorRef ink = glim_color(f.tag == 3 ? f->palette[kEgress] : f->palette[kHudText], 1);
    f.tagText.foregroundColor = ink;
    CGColorRelease(ink);
    // CATextLayer draws from the top; centre the 12 pt line (≈ 15 pt line height) in 20 pt.
    f.tagText.frame = CGRectMake(kTagPad, (kTagH - 15) / 2, textW, 15);
    f.tagChip.hidden = NO;
  } else {
    f.tagChip.hidden = YES;
  }

  // GLIM-154 sprites (badges, cards), above everything else, in the order given. A hovered
  // peek sprite (a card under the pointer) shows the source through it.
  for (NSUInteger i = 0; i < f.sprites.count; i++) {
    GlimSprite *s = f.sprites[i];
    s.layer.frame = CGRectOffset(s.rect, -win.origin.x, -win.origin.y);
    BOOL peeked = (s.flags & kSpritePeek) && (NSInteger)i == f.hover;
    s.layer.opacity = (float)(peeked ? f.peekOpacity : s.opacity);
  }
  CGFloat backing = f.panel.backingScaleFactor > 0 ? f.panel.backingScaleFactor : 2;
  f.tagText.contentsScale = backing;
  f.ticks.contentsScale = backing;
  f.halo.contentsScale = backing;
  [CATransaction commit];
}

// The interactive sprite under the pointer (topmost first), or -1. Global top-left points.
static int glim_frame_hit(GlimFrame *f) {
  if (!f.panel.visible) return -1;
  NSPoint m = [NSEvent mouseLocation];  // Cocoa: bottom-left origin on the primary screen
  CGPoint p = CGPointMake(m.x, glim_primary_height() - m.y);
  for (NSInteger i = (NSInteger)f.sprites.count - 1; i >= 0; i--) {
    GlimSprite *s = f.sprites[(NSUInteger)i];
    if ((s.flags & kSpriteInteractive) && CGRectContainsPoint(s.rect, p)) return (int)i;
  }
  return -1;
}

static void glim_frame_track(GlimFrame *f) {
  int hit = glim_frame_hit(f);
  if (hit == f.hover) return;
  f.hover = hit;
  // Click-through everywhere except over a badge or card.
  f.panel.ignoresMouseEvents = hit < 0;
  glim_frame_layout(f);
}

// Track the pointer only while there is something to hit.
static void glim_frame_sync_tracker(GlimFrame *f) {
  BOOL want = NO;
  for (GlimSprite *s in f.sprites) {
    if (s.flags & kSpriteInteractive) {
      want = YES;
      break;
    }
  }
  if (want && !f.tracker) {
    __weak GlimFrame *weak = f;
    f.tracker = [NSTimer timerWithTimeInterval:1.0 / 30
                                       repeats:YES
                                         block:^(NSTimer *timer) {
                                           GlimFrame *strong = weak;
                                           if (strong) {
                                             glim_frame_track(strong);
                                           } else {
                                             [timer invalidate];
                                           }
                                         }];
    [[NSRunLoop mainRunLoop] addTimer:f.tracker forMode:NSRunLoopCommonModes];
  } else if (!want && f.tracker) {
    [f.tracker invalidate];
    f.tracker = nil;
  }
  if (!want) {
    f.hover = -1;
    f.panel.ignoresMouseEvents = YES;
  }
}

typedef struct {
  int op;
  uint64_t id;
  double nums[4];
  int32_t ints[3];
  const uint32_t *palette;
  const char *text;
  uint64_t out;
  int32_t status;
  // GLIM-154 kSprites
  const double *geom;
  const int32_t *meta;
  const uint8_t *pixels;
  int64_t bytes;
} glim_frame_call;

enum { kCreate, kRect, kStyle, kHighlight, kShow, kDestroy, kWindowId, kSprites, kPointer };

static void glim_frame_do(void *ctx) {
  glim_frame_call *c = (glim_frame_call *)ctx;
  c->status = GLIM_OK;
  if (!g_frames) g_frames = [NSMutableDictionary dictionary];
  if (c->op == kCreate) {
    [NSApplication sharedApplication];
    NSPanel *panel = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, 1, 1)
                                                styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                                  backing:NSBackingStoreBuffered
                                                    defer:NO];
    panel.releasedWhenClosed = NO;
    panel.ignoresMouseEvents = YES;
    panel.opaque = NO;
    panel.backgroundColor = NSColor.clearColor;
    panel.hasShadow = NO;
    panel.hidesOnDeactivate = NO;
    panel.floatingPanel = YES;  // sets level to NSFloatingWindowLevel, so the level comes after it
    panel.level = kFrameLevel;
    panel.becomesKeyOnlyIfNeeded = YES;
    panel.movable = NO;
    panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary |
                               NSWindowCollectionBehaviorIgnoresCycle | NSWindowCollectionBehaviorFullScreenAuxiliary;
    panel.sharingType = NSWindowSharingNone;
    GlimFrameView *view = [[GlimFrameView alloc] initWithFrame:NSMakeRect(0, 0, 1, 1)];
    CALayer *root = [CALayer layer];
    root.geometryFlipped = YES;
    view.layer = root;
    view.wantsLayer = YES;
    panel.contentView = view;

    GlimFrame *f = [GlimFrame new];
    f.panel = panel;
    f.sprites = [NSMutableArray array];
    f.hover = -1;
    f.click = -1;
    f.peekOpacity = 0.08;
    view.owner = f;
    f.highlightHalo = [CAShapeLayer layer];
    f.highlight = [CAShapeLayer layer];
    f.halo = [CAShapeLayer layer];
    f.ticks = [CAShapeLayer layer];
    f.tagChip = [CALayer layer];
    f.tagText = [CATextLayer layer];
    f.highlightHalo.hidden = YES;
    f.highlight.hidden = YES;
    f.tagChip.hidden = YES;
    [f.tagChip addSublayer:f.tagText];
    for (CALayer *l in @[ f.highlightHalo, f.highlight, f.halo, f.ticks, f.tagChip ]) [root addSublayer:l];
    const uint32_t defaults[kPaletteSize] = {0x0A63C9FF, 0x00000099, 0xFFFFFFFF, 0x1C1C1EE0,
                                             0xF5F5F7FF, 0x0A63C93D, 0xC4B0FFFF};
    memcpy(f->palette, defaults, sizeof defaults);
    uint64_t id = g_nextFrame++;
    g_frames[@(id)] = f;
    c->out = id;
    return;
  }
  GlimFrame *f = g_frames[@(c->id)];
  if (!f) {
    glim_set_error("no frame %llu", (unsigned long long)c->id);
    c->status = GLIM_E_ARGS;
    return;
  }
  switch (c->op) {
    case kRect:
      f.region = CGRectMake(c->nums[0], c->nums[1], c->nums[2], c->nums[3]);
      glim_frame_layout(f);
      return;
    case kStyle:
      f.style = c->ints[0];
      if (c->palette) memcpy(f->palette, c->palette, sizeof(uint32_t) * kPaletteSize);
      f.tag = c->ints[1];
      f.tagString = c->text ? [NSString stringWithUTF8String:c->text] : @"";
      f.tagBelow = c->ints[2] != 0;
      glim_frame_layout(f);
      return;
    case kHighlight:
      f.hasHighlight = c->ints[0] != 0;
      if (f.hasHighlight) f.highlightRect = CGRectMake(c->nums[0], c->nums[1], c->nums[2], c->nums[3]);
      glim_frame_layout(f);
      return;
    case kShow:
      if (c->ints[0]) {
        glim_frame_layout(f);
        [f.panel orderFrontRegardless];
      } else {
        [f.panel orderOut:nil];
        f.hover = -1;
        f.panel.ignoresMouseEvents = YES;
      }
      return;
    case kWindowId: {
      NSInteger n = f.panel.windowNumber;
      c->out = n > 0 ? (uint64_t)n : 0;
      return;
    }
    case kSprites: {
      for (GlimSprite *s in f.sprites) [s.layer removeFromSuperlayer];
      [f.sprites removeAllObjects];
      f.peekOpacity = c->nums[0];
      CALayer *root = f.panel.contentView.layer;
      CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
      int64_t off = 0;
      for (int32_t i = 0; i < c->ints[0]; i++) {
        const double *g = c->geom + (size_t)i * 5;
        const int32_t *m = c->meta + (size_t)i * 3;
        int32_t pw = m[0], ph = m[1];
        int64_t len = (int64_t)pw * ph * 4;
        if (pw <= 0 || ph <= 0 || off + len > c->bytes) {
          glim_set_error("bad sprite %d", i);
          c->status = GLIM_E_ARGS;
          break;
        }
        NSData *data = [NSData dataWithBytes:c->pixels + off length:(NSUInteger)len];
        off += len;
        CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)data);
        CGImageRef image = CGImageCreate((size_t)pw, (size_t)ph, 8, 32, (size_t)pw * 4, space,
                                         kCGImageAlphaPremultipliedLast | kCGBitmapByteOrderDefault, provider, NULL,
                                         false, kCGRenderingIntentDefault);
        CGDataProviderRelease(provider);
        if (!image) continue;
        CALayer *layer = [CALayer layer];
        layer.contents = (__bridge id)image;  // the layer retains it
        CGImageRelease(image);
        layer.contentsGravity = kCAGravityResize;
        // Sprites swap instantly (spec §9: the frame never animates).
        layer.actions = @{
          @"contents" : [NSNull null],
          @"position" : [NSNull null],
          @"bounds" : [NSNull null],
          @"opacity" : [NSNull null],
          @"hidden" : [NSNull null]
        };
        GlimSprite *s = [GlimSprite new];
        s.rect = CGRectMake(g[0], g[1], g[2], g[3]);
        s.opacity = g[4];
        s.flags = m[2];
        s.layer = layer;
        [root addSublayer:layer];
        [f.sprites addObject:s];
      }
      CGColorSpaceRelease(space);
      if (f.hover >= (int)f.sprites.count) f.hover = -1;
      glim_frame_sync_tracker(f);
      glim_frame_track(f);
      glim_frame_layout(f);
      return;
    }
    case kPointer:
      c->out = (uint64_t)(uint32_t)f.hover | ((uint64_t)(uint32_t)f.click << 32);
      f.click = -1;
      return;
    case kDestroy:
      [f.tracker invalidate];
      f.tracker = nil;
      [f.panel orderOut:nil];
      [f.panel close];
      [g_frames removeObjectForKey:@(c->id)];
      return;
    default:
      c->status = GLIM_E_ARGS;
  }
}

static int32_t glim_frame_on_main(glim_frame_call *c) {
  if (pthread_main_np()) {
    glim_frame_do(c);
  } else {
    dispatch_sync_f(dispatch_get_main_queue(), c, glim_frame_do);
  }
  return c->status;
}

// Create a hidden frame panel. *out = its handle (an id, not a pointer).
GLIM_EXPORT int32_t glim_frame_create(uint64_t *out) {
  if (!out) return GLIM_E_ARGS;
  glim_frame_call c = {kCreate, 0, {0}, {0}, NULL, NULL, 0, GLIM_E_API, NULL, NULL, NULL, 0};
  int32_t r = glim_frame_on_main(&c);
  *out = c.out;
  return r;
}

// rect = {x, y, w, h} of the pinned region in global points (top-left origin). `scale` is
// ignored on macOS (Core Animation follows the panel's backing scale).
GLIM_EXPORT int32_t glim_frame_set_rect(uint64_t frame, const double *rect, double scale) {
  if (!rect || !(rect[2] > 0) || !(rect[3] > 0)) {
    glim_set_error("bad frame rect");
    return GLIM_E_ARGS;
  }
  glim_frame_call c = {kRect, frame, {rect[0], rect[1], rect[2], rect[3]}, {0}, NULL, NULL, 0, GLIM_E_API, NULL, NULL, NULL, 0};
  return glim_frame_on_main(&c);
}

// style: 0 running, 1 paused / error. palette: RGBA u32[7] (accent, picker-halo, picker-stroke,
// picker-hud, picker-hud-text, box-linked-fill, egress-dark; null keeps the current ones).
// tag: 0 none, 1 live, 2 paused, 3 cloud; tagText UTF-8; tagBelow: chip under the region.
GLIM_EXPORT int32_t glim_frame_set_style(uint64_t frame, int32_t style, const uint32_t *palette, int32_t tag,
                                         const char *tagText, int32_t tagBelow) {
  glim_frame_call c = {kStyle, frame, {0}, {style, tag, tagBelow}, palette, tagText, 0, GLIM_E_API, NULL, NULL, NULL, 0};
  return glim_frame_on_main(&c);
}

// The linked block's box in global points (has = 0 removes it).
GLIM_EXPORT int32_t glim_frame_set_highlight(uint64_t frame, int32_t has, const double *rect) {
  if (has && !rect) return GLIM_E_ARGS;
  glim_frame_call c = {kHighlight, frame, {0}, {has, 0, 0}, NULL, NULL, 0, GLIM_E_API, NULL, NULL, NULL, 0};
  if (has) memcpy(c.nums, rect, sizeof c.nums);
  return glim_frame_on_main(&c);
}

// Show (orderFrontRegardless: never activates) or hide (orderOut).
GLIM_EXPORT int32_t glim_frame_show(uint64_t frame, int32_t visible) {
  glim_frame_call c = {kShow, frame, {0}, {visible, 0, 0}, NULL, NULL, 0, GLIM_E_API, NULL, NULL, NULL, 0};
  return glim_frame_on_main(&c);
}

// GLIM-154: the badges and cards over the region. count sprites; geom f64[count * 5] = x, y,
// w, h (global points, top-left origin), opacity; meta i32[count * 3] = pixel width, pixel
// height, flags (1 interactive: hit-tested, the panel catches clicks over it; 2 peek: drops to
// `peek` opacity while hovered); pixels: premultiplied RGBA, the sprites back to back, `bytes`
// long. Replaces the previous set; count 0 removes them all.
GLIM_EXPORT int32_t glim_frame_set_sprites(uint64_t frame, int32_t count, const double *geom, const int32_t *meta,
                                           const uint8_t *pixels, int64_t bytes, double peek) {
  if (count < 0 || (count > 0 && (!geom || !meta || !pixels))) return GLIM_E_ARGS;
  glim_frame_call c = {kSprites, frame, {peek, 0, 0, 0}, {count, 0, 0}, NULL, NULL, 0, GLIM_E_API,
                       geom, meta, pixels, bytes};
  return glim_frame_on_main(&c);
}

// GLIM-154: out i32[2] = the interactive sprite under the pointer (-1 none), and the sprite
// clicked since the last call (-1 none).
GLIM_EXPORT int32_t glim_frame_pointer(uint64_t frame, int32_t *out) {
  if (!out) return GLIM_E_ARGS;
  glim_frame_call c = {kPointer, frame, {0}, {0}, NULL, NULL, 0, GLIM_E_API, NULL, NULL, NULL, 0};
  int32_t r = glim_frame_on_main(&c);
  out[0] = (int32_t)(uint32_t)(c.out & 0xFFFFFFFFu);
  out[1] = (int32_t)(uint32_t)(c.out >> 32);
  return r;
}

// The panel's CGWindowID (for the SCK by-window exclusion fallback); 0 before it is shown.
GLIM_EXPORT int32_t glim_frame_window_id(uint64_t frame, uint64_t *out) {
  if (!out) return GLIM_E_ARGS;
  glim_frame_call c = {kWindowId, frame, {0}, {0}, NULL, NULL, 0, GLIM_E_API, NULL, NULL, NULL, 0};
  int32_t r = glim_frame_on_main(&c);
  *out = c.out;
  return r;
}

typedef struct {
  uint64_t id;
  char json[384];
  int32_t status;
} glim_frame_info_call;

static void glim_frame_info_do(void *ctx) {
  glim_frame_info_call *c = (glim_frame_info_call *)ctx;
  GlimFrame *f = g_frames[@(c->id)];
  if (!f) {
    c->status = GLIM_E_ARGS;
    return;
  }
  NSPanel *p = f.panel;
  NSRect r = p.frame;
  snprintf(c->json, sizeof c->json,
           "{\"ignoresMouseEvents\":%d,\"level\":%ld,\"sharingType\":%ld,\"collectionBehavior\":%lu,"
           "\"visible\":%d,\"canBecomeKey\":%d,\"x\":%.1f,\"y\":%.1f,\"w\":%.1f,\"h\":%.1f,\"windowNumber\":%ld,"
           "\"sprites\":%lu,\"hover\":%d}",
           p.ignoresMouseEvents ? 1 : 0, (long)p.level, (long)p.sharingType, (unsigned long)p.collectionBehavior,
           p.visible ? 1 : 0, p.canBecomeKeyWindow ? 1 : 0, r.origin.x, r.origin.y, r.size.width, r.size.height,
           (long)p.windowNumber, (unsigned long)f.sprites.count, f.hover);
  c->status = GLIM_OK;
}

// Diagnostics / smoke tests: what AppKit reports for the frame panel, as JSON. Returns the
// length (glim_copy_out convention), or -1 for an unknown handle.
GLIM_EXPORT int32_t glim_frame_info(uint64_t frame, char *buf, int32_t cap) {
  glim_frame_info_call c = {frame, {0}, GLIM_E_API};
  if (pthread_main_np()) {
    glim_frame_info_do(&c);
  } else {
    dispatch_sync_f(dispatch_get_main_queue(), &c, glim_frame_info_do);
  }
  if (c.status != GLIM_OK) return -1;
  return glim_copy_out(c.json, buf, cap);
}

GLIM_EXPORT int32_t glim_frame_destroy(uint64_t frame) {
  glim_frame_call c = {kDestroy, frame, {0}, {0}, NULL, NULL, 0, GLIM_E_API, NULL, NULL, NULL, 0};
  return glim_frame_on_main(&c);
}
