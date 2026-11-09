// Pinned-region frame for Live (GLIM-90, docs/design/specs/live-popup.md 2.4 and 12.2).
//
// A click-through, always-on-top, capture-excluded window around the pinned region that
// draws the corner ticks, the region tag and the linked-block highlight. Electrobun has no
// click-through windows, and WS_EX_LAYERED breaks a transparent WebView2, so it is a plain
// Win32 popup painted with UpdateLayeredWindow from a premultiplied 32-bit DIB:
//
//   WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST
//   WM_NCHITTEST -> HTTRANSPARENT, SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
//
// The windows live on a helper-owned UI thread (its own message loop, per-monitor DPI aware
// v2), so the Bun worker never pumps messages; every export SendMessage()s to a message-only
// controller window on that thread. Coordinates are PHYSICAL virtual-desktop pixels: the
// TypeScript binding maps the global logical region with the capture geometry, and passes
// the display scale so the 12 px ticks / 20 px tag are scaled like the rest of the UI.
//
// Layout (logical px, scaled by `scale`), mirrored by pinnedFrameLayout() in
// app/src/bun/services/live/frame-layout.ts:
//   window = region + 16 on every side, 40 on the tag's side when a tag shows
//   ticks: L-shapes, arm 12, stroke 2, 1 px outside the region; 1 px halo around them
//   tag: 20 high, 6 px side padding, 4 px above the top-left tick (or below the bottom-left)
//   highlight: linked-fill rounded rect (radius 3) with 1 px stroke + 1 px halo
//
// GLIM-154: sprites. The Live view rasterises the numbered badges and overlay cards
// (live-popup.md section 2.6); glim_frame_set_sprites hands them over as premultiplied RGBA
// bitmaps with a physical rect each, composited above the ticks. The window stays
// click-through except over "interactive" sprites: while it has any, a 33 ms timer on the UI
// thread reads the cursor and drops WS_EX_TRANSPARENT (and answers HTCLIENT) only while the
// cursor is over one, so a click there picks the block (glim_frame_pointer) and every other
// click reaches the game. Layered hit-testing also lets clicks through fully transparent
// pixels. A hovered "peek" sprite (a card) drops to the peek opacity so the source shows.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "glimpse.h"

namespace {

constexpr UINT WM_GLIM_CALL = WM_APP + 0x47;
constexpr double kMargin = 16, kTagMargin = 40, kArm = 12, kStroke = 2, kGap = 1, kHalo = 1;
constexpr double kTagH = 20, kTagPad = 6, kTagGap = 4, kRadiusBox = 3, kRadiusTag = 4, kFontPx = 12;

enum Palette { kAccent, kHaloC, kStrokeC, kHud, kHudText, kLinkedFill, kEgress, kPaletteSize };

enum SpriteFlags { kSpriteInteractive = 1, kSpritePeek = 2 };
constexpr UINT_PTR kTrackTimer = 1;
constexpr UINT kTrackMs = 33;

struct Sprite {
	double x = 0, y = 0, w = 0, h = 0;  // physical px
	double opacity = 1;
	int pw = 0, ph = 0, flags = 0;
	std::vector<uint32_t> px;  // premultiplied BGRA, top-down
};

struct Frame {
	HWND hwnd = nullptr;
	double rx = 0, ry = 0, rw = 0, rh = 0;  // region, physical px
	double scale = 1;
	int style = 0;  // 0 running, 1 paused / error
	uint32_t palette[kPaletteSize] = {0x0A63C9FF, 0x00000099, 0xFFFFFFFF, 0x1C1C1EE0, 0xF5F5F7FF, 0x0A63C93D, 0xC4B0FFFF};
	int tag = 0;  // 0 none, 1 live, 2 paused, 3 cloud
	std::wstring tagText;
	bool tagBelow = false;
	bool hasHighlight = false;
	double hx = 0, hy = 0, hw = 0, hh = 0;  // physical px
	bool visible = false;
	std::vector<Sprite> sprites;  // GLIM-154
	double peek = 0.08;
	int hover = -1;
	int click = -1;
	bool tracking = false;
	// GLIM-163: GetLastError() of the last failed SetWindowDisplayAffinity (0: it succeeded).
	DWORD affinityError = 0;
};

// Keep the window out of every capture (build 19041+). Asked again on every show, in case
// the first call (on a never-shown window) didn't stick; glim_frame_info reports the error.
void excludeFromCapture(Frame& f) {
	DWORD now = 0;
	if (GetWindowDisplayAffinity(f.hwnd, &now) && now == WDA_EXCLUDEFROMCAPTURE) return;
	f.affinityError = SetWindowDisplayAffinity(f.hwnd, WDA_EXCLUDEFROMCAPTURE) ? 0 : GetLastError();
}

struct Call {
	int op;
	uint64_t id;
	const double* nums;
	int32_t ints[4];
	const uint32_t* palette;
	const char* text;
	uint64_t out;
	int32_t status;
	// GLIM-154 kSprites
	const double* geom;
	const int32_t* meta;
	const uint8_t* pixels;
	int64_t bytes;
};

enum Op { kCreate, kRect, kStyle, kHighlight, kShow, kDestroy, kWindowId, kSprites, kPointer };

std::mutex g_startLock;
HANDLE g_thread = nullptr;
HWND g_ctrl = nullptr;
std::map<uint64_t, Frame> g_frames;  // UI thread only
uint64_t g_nextId = 1;

typedef DPI_AWARENESS_CONTEXT(WINAPI* PFN_SetThreadDpiAwarenessContext)(DPI_AWARENESS_CONTEXT);

std::wstring widen(const char* utf8) {
	if (!utf8 || !*utf8) return L"";
	int n = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
	if (n <= 1) return L"";
	std::wstring w((size_t)n - 1, L'\0');
	MultiByteToWideChar(CP_UTF8, 0, utf8, -1, &w[0], n);
	return w;
}

// ---- drawing into a premultiplied BGRA buffer --------------------------------------

struct Canvas {
	int w, h;
	uint32_t* px;  // premultiplied BGRA, top-down
};

struct Rgba {
	double r, g, b, a;  // 0..1, straight alpha
};

Rgba rgba(uint32_t c, double opacity = 1) {
	return {((c >> 24) & 0xFF) / 255.0, ((c >> 16) & 0xFF) / 255.0, ((c >> 8) & 0xFF) / 255.0,
	        (c & 0xFF) / 255.0 * opacity};
}

// Source-over of colour `c` with extra coverage `cov` (0..1) onto pixel (x, y).
void blend(Canvas& cv, int x, int y, Rgba c, double cov) {
	if (x < 0 || y < 0 || x >= cv.w || y >= cv.h || cov <= 0) return;
	double a = c.a * std::min(1.0, cov);
	uint32_t& d = cv.px[(size_t)y * cv.w + x];
	double db = (d & 0xFF) / 255.0, dg = ((d >> 8) & 0xFF) / 255.0, dr = ((d >> 16) & 0xFF) / 255.0,
	       da = ((d >> 24) & 0xFF) / 255.0;
	double ob = c.b * a + db * (1 - a), og = c.g * a + dg * (1 - a), orr = c.r * a + dr * (1 - a),
	       oa = a + da * (1 - a);
	auto q = [](double v) { return (uint32_t)std::lround(std::clamp(v, 0.0, 1.0) * 255); };
	d = q(ob) | (q(og) << 8) | (q(orr) << 16) | (q(oa) << 24);
}

// Axis-aligned rect with fractional edges (area coverage per pixel), optional corner radius.
void fillRect(Canvas& cv, double x, double y, double w, double h, Rgba c, double radius = 0) {
	if (w <= 0 || h <= 0) return;
	int x0 = (int)std::floor(x), y0 = (int)std::floor(y), x1 = (int)std::ceil(x + w), y1 = (int)std::ceil(y + h);
	for (int py = y0; py < y1; py++) {
		double cy = std::min(y + h, py + 1.0) - std::max(y, (double)py);
		for (int px = x0; px < x1; px++) {
			double cx = std::min(x + w, px + 1.0) - std::max(x, (double)px);
			double cov = cx * cy;
			if (radius > 0) {
				// Distance from the pixel centre to the rounded corner's arc.
				double pxc = px + 0.5, pyc = py + 0.5;
				double qx = std::max({x + radius - pxc, pxc - (x + w - radius), 0.0});
				double qy = std::max({y + radius - pyc, pyc - (y + h - radius), 0.0});
				if (qx > 0 && qy > 0) cov *= std::clamp(radius - std::sqrt(qx * qx + qy * qy) + 0.5, 0.0, 1.0);
			}
			blend(cv, px, py, c, cov);
		}
	}
}

// A premultiplied sprite scaled (nearest) into the rect at (x, y), source-over at `opacity`.
void drawSprite(Canvas& cv, const Sprite& sp, double x, double y, double opacity) {
	if (sp.pw <= 0 || sp.ph <= 0 || sp.w <= 0 || sp.h <= 0 || opacity <= 0) return;
	int x0 = (int)std::lround(x), y0 = (int)std::lround(y);
	int dw = std::max(1, (int)std::lround(sp.w)), dh = std::max(1, (int)std::lround(sp.h));
	double k = std::clamp(opacity, 0.0, 1.0);
	for (int dy = 0; dy < dh; dy++) {
		int py = y0 + dy;
		if (py < 0 || py >= cv.h) continue;
		int sy = std::min(sp.ph - 1, (int)((double)dy * sp.ph / dh));
		for (int dx = 0; dx < dw; dx++) {
			int px = x0 + dx;
			if (px < 0 || px >= cv.w) continue;
			int sx = std::min(sp.pw - 1, (int)((double)dx * sp.pw / dw));
			uint32_t s = sp.px[(size_t)sy * sp.pw + sx];
			double sa = ((s >> 24) & 0xFF) / 255.0 * k;
			if (sa <= 0) continue;
			uint32_t& d = cv.px[(size_t)py * cv.w + px];
			auto ch = [&](int shift) {
				double sv = ((s >> shift) & 0xFF) / 255.0 * k, dv = ((d >> shift) & 0xFF) / 255.0;
				return (uint32_t)std::lround(std::clamp(sv + dv * (1 - sa), 0.0, 1.0) * 255) << shift;
			};
			d = ch(0) | ch(8) | ch(16) | ch(24);
		}
	}
}

struct Layout {
	double winX, winY, winW, winH;  // physical
	double rx, ry;                  // region origin inside the window
};

Layout layoutOf(const Frame& f) {
	double s = f.scale;
	double top = (f.tag && !f.tagBelow ? kTagMargin : kMargin) * s;
	double bottom = (f.tag && f.tagBelow ? kTagMargin : kMargin) * s;
	double side = kMargin * s;
	Layout l;
	l.winX = std::floor(f.rx - side);
	l.winY = std::floor(f.ry - top);
	l.winW = std::ceil(f.rw + 2 * side);
	l.winH = std::ceil(f.rh + top + bottom);
	l.rx = f.rx - l.winX;
	l.ry = f.ry - l.winY;
	return l;
}

// Four L-shaped ticks outside the region: each arm `arm` long from the outer corner.
void drawTicks(Canvas& cv, const Layout& l, const Frame& f, double grow, Rgba c) {
	double s = f.scale;
	double off = (kGap + kStroke) * s, arm = kArm * s, st = kStroke * s;
	double L = l.rx - off, T = l.ry - off, R = l.rx + f.rw + off, B = l.ry + f.rh + off;
	auto tick = [&](double ox, double oy, int dx, int dy) {
		// Horizontal arm and vertical arm from the outer corner (ox, oy) going inward.
		double hx = dx > 0 ? ox : ox - arm, vy = dy > 0 ? oy : oy - arm;
		double hy = dy > 0 ? oy : oy - st, vx = dx > 0 ? ox : ox - st;
		fillRect(cv, hx - grow, hy - grow, arm + 2 * grow, st + 2 * grow, c);
		fillRect(cv, vx - grow, vy - grow, st + 2 * grow, arm + 2 * grow, c);
	};
	tick(L, T, +1, +1);
	tick(R, T, -1, +1);
	tick(L, B, +1, -1);
	tick(R, B, -1, -1);
}

// Text coverage via GDI: white grayscale-antialiased text on black, red channel = coverage.
void drawText(Canvas& cv, double x, double y, double h, const std::wstring& text, double scale, Rgba c,
              double* widthOut) {
	*widthOut = 0;
	if (text.empty()) return;
	HDC dc = CreateCompatibleDC(nullptr);
	int fontPx = (int)std::lround(kFontPx * scale);
	HFONT font = CreateFontW(-fontPx, 0, 0, 0, FW_MEDIUM, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
	                         CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY, DEFAULT_PITCH, L"Segoe UI");
	HGDIOBJ oldFont = SelectObject(dc, font);
	SIZE size{};
	GetTextExtentPoint32W(dc, text.c_str(), (int)text.size(), &size);
	*widthOut = size.cx;
	int tw = std::max(1, (int)size.cx), th = std::max(1, (int)std::ceil(h));
	BITMAPINFO bi{};
	bi.bmiHeader.biSize = sizeof bi.bmiHeader;
	bi.bmiHeader.biWidth = tw;
	bi.bmiHeader.biHeight = -th;
	bi.bmiHeader.biPlanes = 1;
	bi.bmiHeader.biBitCount = 32;
	bi.bmiHeader.biCompression = BI_RGB;
	void* bits = nullptr;
	HBITMAP bmp = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
	if (bmp && bits) {
		HGDIOBJ oldBmp = SelectObject(dc, bmp);
		memset(bits, 0, (size_t)tw * th * 4);
		SetBkMode(dc, TRANSPARENT);
		SetTextColor(dc, RGB(255, 255, 255));
		RECT r{0, 0, tw, th};
		DrawTextW(dc, text.c_str(), (int)text.size(), &r, DT_SINGLELINE | DT_VCENTER | DT_LEFT | DT_NOPREFIX);
		GdiFlush();
		const uint32_t* src = (const uint32_t*)bits;
		for (int py = 0; py < th; py++)
			for (int px = 0; px < tw; px++) {
				double cov = ((src[(size_t)py * tw + px] >> 16) & 0xFF) / 255.0;
				blend(cv, (int)std::lround(x) + px, (int)std::lround(y) + py, c, cov);
			}
		SelectObject(dc, oldBmp);
		DeleteObject(bmp);
	}
	SelectObject(dc, oldFont);
	DeleteObject(font);
	DeleteDC(dc);
}

double measureText(const std::wstring& text, double scale) {
	if (text.empty()) return 0;
	HDC dc = CreateCompatibleDC(nullptr);
	HFONT font = CreateFontW(-(int)std::lround(kFontPx * scale), 0, 0, 0, FW_MEDIUM, FALSE, FALSE, FALSE,
	                         DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY,
	                         DEFAULT_PITCH, L"Segoe UI");
	HGDIOBJ old = SelectObject(dc, font);
	SIZE size{};
	GetTextExtentPoint32W(dc, text.c_str(), (int)text.size(), &size);
	SelectObject(dc, old);
	DeleteObject(font);
	DeleteDC(dc);
	return size.cx;
}

void paint(Frame& f) {
	if (!f.hwnd || f.rw <= 0 || f.rh <= 0) return;
	Layout l = layoutOf(f);
	int w = (int)l.winW, h = (int)l.winH;
	if (w <= 0 || h <= 0) return;
	BITMAPINFO bi{};
	bi.bmiHeader.biSize = sizeof bi.bmiHeader;
	bi.bmiHeader.biWidth = w;
	bi.bmiHeader.biHeight = -h;
	bi.bmiHeader.biPlanes = 1;
	bi.bmiHeader.biBitCount = 32;
	bi.bmiHeader.biCompression = BI_RGB;
	HDC screen = GetDC(nullptr);
	HDC mem = CreateCompatibleDC(screen);
	void* bits = nullptr;
	HBITMAP bmp = CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
	if (!bmp || !bits) {
		DeleteDC(mem);
		ReleaseDC(nullptr, screen);
		return;
	}
	HGDIOBJ old = SelectObject(mem, bmp);
	Canvas cv{w, h, (uint32_t*)bits};
	memset(bits, 0, (size_t)w * h * 4);
	double s = f.scale;

	// Linked block (under the ticks): halo, stroke, fill.
	if (f.hasHighlight) {
		double x = f.hx - l.winX, y = f.hy - l.winY;
		double t = kHalo * s;
		fillRect(cv, x - 2 * t, y - 2 * t, f.hw + 4 * t, f.hh + 4 * t, rgba(f.palette[kHaloC]), kRadiusBox * s + 2 * t);
		fillRect(cv, x - t, y - t, f.hw + 2 * t, f.hh + 2 * t, rgba(f.palette[kStrokeC]), kRadiusBox * s + t);
		// Clear the inside back to the fill colour: draw the fill over a cleared area.
		for (int py = (int)std::floor(y); py < (int)std::ceil(y + f.hh); py++)
			for (int px = (int)std::floor(x); px < (int)std::ceil(x + f.hw); px++)
				if (px >= 0 && py >= 0 && px < w && py < h) cv.px[(size_t)py * w + px] = 0;
		fillRect(cv, x, y, f.hw, f.hh, rgba(f.palette[kLinkedFill]), kRadiusBox * s);
	}

	// Ticks: halo first, then the stroke. Paused / error: picker-stroke at 60 %.
	drawTicks(cv, l, f, kHalo * s, rgba(f.palette[kHaloC]));
	drawTicks(cv, l, f, 0, f.style == 0 ? rgba(f.palette[kAccent]) : rgba(f.palette[kStrokeC], 0.6));

	// Region tag (only while the popup is hidden; the caller decides).
	if (f.tag != 0 && !f.tagText.empty()) {
		double textW = measureText(f.tagText, s);
		double chipW = textW + 2 * kTagPad * s, chipH = kTagH * s;
		double off = (kGap + kStroke) * s;
		double cx = l.rx - off;
		double cy = f.tagBelow ? l.ry + f.rh + off + kTagGap * s : l.ry - off - kTagGap * s - chipH;
		fillRect(cv, cx, cy, chipW, chipH, rgba(f.palette[kHud]), kRadiusTag * s);
		double ignored = 0;
		Rgba ink = f.tag == 3 ? rgba(f.palette[kEgress]) : rgba(f.palette[kHudText]);
		drawText(cv, cx + kTagPad * s, cy, chipH, f.tagText, s, ink, &ignored);
	}

	// GLIM-154 sprites (badges, cards), above everything else, in the order given.
	for (size_t i = 0; i < f.sprites.size(); i++) {
		const Sprite& sp = f.sprites[i];
		bool peeked = (sp.flags & kSpritePeek) && (int)i == f.hover;
		drawSprite(cv, sp, sp.x - l.winX, sp.y - l.winY, peeked ? f.peek : sp.opacity);
	}

	POINT dst{(LONG)l.winX, (LONG)l.winY};
	SIZE size{w, h};
	POINT src{0, 0};
	BLENDFUNCTION blendFn{AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
	UpdateLayeredWindow(f.hwnd, screen, &dst, &size, mem, &src, 0, &blendFn, ULW_ALPHA);
	SelectObject(mem, old);
	DeleteObject(bmp);
	DeleteDC(mem);
	ReleaseDC(nullptr, screen);
}

Frame* frameOf(HWND hwnd) {
	for (auto& kv : g_frames)
		if (kv.second.hwnd == hwnd) return &kv.second;
	return nullptr;
}

// The interactive sprite under the cursor (topmost first), or -1. Physical px (the UI thread
// is per-monitor DPI aware v2, so GetCursorPos is physical too).
int hitSprite(const Frame& f) {
	if (!f.visible) return -1;
	POINT p{};
	if (!GetCursorPos(&p)) return -1;
	for (int i = (int)f.sprites.size() - 1; i >= 0; i--) {
		const Sprite& sp = f.sprites[(size_t)i];
		if ((sp.flags & kSpriteInteractive) && p.x >= sp.x && p.x < sp.x + sp.w && p.y >= sp.y && p.y < sp.y + sp.h)
			return i;
	}
	return -1;
}

// Click-through everywhere except over a badge or card.
void setClickThrough(Frame& f, bool through) {
	LONG_PTR ex = GetWindowLongPtrW(f.hwnd, GWL_EXSTYLE);
	LONG_PTR next = through ? (ex | WS_EX_TRANSPARENT) : (ex & ~(LONG_PTR)WS_EX_TRANSPARENT);
	if (next != ex) SetWindowLongPtrW(f.hwnd, GWL_EXSTYLE, next);
}

void track(Frame& f) {
	int hit = hitSprite(f);
	if (hit == f.hover) return;
	f.hover = hit;
	setClickThrough(f, hit < 0);
	paint(f);
}

// Poll the cursor only while there is something to hit.
void syncTracking(Frame& f) {
	bool want = false;
	for (const Sprite& sp : f.sprites)
		if (sp.flags & kSpriteInteractive) want = true;
	if (want && !f.tracking) {
		f.tracking = SetTimer(f.hwnd, kTrackTimer, kTrackMs, nullptr) != 0;
	} else if (!want && f.tracking) {
		KillTimer(f.hwnd, kTrackTimer);
		f.tracking = false;
	}
	if (!want) {
		f.hover = -1;
		setClickThrough(f, true);
	}
}

LRESULT CALLBACK frameProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
	switch (msg) {
		case WM_NCHITTEST: {
			Frame* f = frameOf(hwnd);
			return f && f->hover >= 0 && hitSprite(*f) == f->hover ? HTCLIENT : HTTRANSPARENT;
		}
		case WM_MOUSEACTIVATE:
			return MA_NOACTIVATE;
		case WM_SETCURSOR: {
			Frame* f = frameOf(hwnd);
			if (f && f->hover >= 0) {
				SetCursor(LoadCursor(nullptr, IDC_HAND));
				return TRUE;
			}
			return DefWindowProcW(hwnd, msg, wp, lp);
		}
		case WM_LBUTTONDOWN: {
			Frame* f = frameOf(hwnd);
			if (f && f->hover >= 0) f->click = f->hover;
			return 0;
		}
		case WM_TIMER:
			if (wp == kTrackTimer) {
				Frame* f = frameOf(hwnd);
				if (f) track(*f);
				return 0;
			}
			return DefWindowProcW(hwnd, msg, wp, lp);
		default:
			return DefWindowProcW(hwnd, msg, wp, lp);
	}
}

const wchar_t* kFrameClass = L"GlimpseLiveFrame";
const wchar_t* kCtrlClass = L"GlimpseFrameCtrl";

void handle(Call* c) {
	auto it = c->op == kCreate ? g_frames.end() : g_frames.find(c->id);
	if (c->op != kCreate && it == g_frames.end()) {
		glimSetError("no frame %llu", (unsigned long long)c->id);
		c->status = GLIM_E_ARGS;
		return;
	}
	c->status = GLIM_OK;
	switch (c->op) {
		case kCreate: {
			HWND hwnd = CreateWindowExW(
				WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST, kFrameClass,
				L"Glimpse Live frame", WS_POPUP, 0, 0, 1, 1, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
			if (!hwnd) {
				glimSetError("CreateWindowExW failed: %lu", GetLastError());
				c->status = (int32_t)HRESULT_FROM_WIN32(GetLastError());
				return;
			}
			uint64_t id = g_nextId++;
			Frame f;
			f.hwnd = hwnd;
			// Never in any capture: Glimpse's own, screenshots, screen sharing (build 19041+).
			excludeFromCapture(f);
			g_frames[id] = f;
			c->out = id;
			return;
		}
		case kRect: {
			Frame& f = it->second;
			f.rx = c->nums[0];
			f.ry = c->nums[1];
			f.rw = c->nums[2];
			f.rh = c->nums[3];
			f.scale = c->nums[4] > 0 ? c->nums[4] : 1;
			paint(f);
			return;
		}
		case kStyle: {
			Frame& f = it->second;
			f.style = c->ints[0];
			if (c->palette) memcpy(f.palette, c->palette, sizeof f.palette);
			f.tag = c->ints[1];
			f.tagText = widen(c->text);
			f.tagBelow = c->ints[2] != 0;
			paint(f);
			return;
		}
		case kHighlight: {
			Frame& f = it->second;
			f.hasHighlight = c->ints[0] != 0;
			if (f.hasHighlight) {
				f.hx = c->nums[0];
				f.hy = c->nums[1];
				f.hw = c->nums[2];
				f.hh = c->nums[3];
			}
			paint(f);
			return;
		}
		case kShow: {
			Frame& f = it->second;
			f.visible = c->ints[0] != 0;
			if (f.visible) {
				paint(f);
				ShowWindow(f.hwnd, SW_SHOWNOACTIVATE);
				SetWindowPos(f.hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
				excludeFromCapture(f);
			} else {
				ShowWindow(f.hwnd, SW_HIDE);
				if (f.hover >= 0) {
					f.hover = -1;
					setClickThrough(f, true);
				}
			}
			return;
		}
		case kSprites: {
			Frame& f = it->second;
			std::vector<Sprite> next;
			int64_t off = 0;
			for (int32_t i = 0; i < c->ints[0]; i++) {
				const double* g = c->geom + (size_t)i * 5;
				const int32_t* m = c->meta + (size_t)i * 3;
				int64_t len = (int64_t)m[0] * m[1] * 4;
				if (m[0] <= 0 || m[1] <= 0 || off + len > c->bytes) {
					glimSetError("bad sprite %d", i);
					c->status = GLIM_E_ARGS;
					return;
				}
				Sprite sp;
				sp.x = g[0];
				sp.y = g[1];
				sp.w = g[2];
				sp.h = g[3];
				sp.opacity = g[4];
				sp.pw = m[0];
				sp.ph = m[1];
				sp.flags = m[2];
				sp.px.resize((size_t)sp.pw * sp.ph);
				const uint8_t* src = c->pixels + off;
				// RGBA bytes -> BGRA u32 (both premultiplied).
				for (size_t k = 0; k < sp.px.size(); k++) {
					const uint8_t* q = src + k * 4;
					sp.px[k] = (uint32_t)q[2] | ((uint32_t)q[1] << 8) | ((uint32_t)q[0] << 16) | ((uint32_t)q[3] << 24);
				}
				off += len;
				next.push_back(std::move(sp));
			}
			f.sprites = std::move(next);
			f.peek = c->nums ? c->nums[0] : 0.08;
			syncTracking(f);
			f.hover = hitSprite(f);
			setClickThrough(f, f.hover < 0);
			paint(f);
			return;
		}
		case kPointer: {
			Frame& f = it->second;
			c->out = (uint64_t)(uint32_t)f.hover | ((uint64_t)(uint32_t)f.click << 32);
			f.click = -1;
			return;
		}
		case kWindowId:
			c->out = (uint64_t)(uintptr_t)it->second.hwnd;
			c->ints[0] = (int32_t)it->second.affinityError;  // glim_frame_info (GLIM-163)
			return;
		case kDestroy:
			if (it->second.tracking) KillTimer(it->second.hwnd, kTrackTimer);
			DestroyWindow(it->second.hwnd);
			g_frames.erase(it);
			return;
		default:
			c->status = GLIM_E_ARGS;
	}
}

LRESULT CALLBACK ctrlProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
	if (msg == WM_GLIM_CALL) {
		handle(reinterpret_cast<Call*>(lp));
		return 0;
	}
	return DefWindowProcW(hwnd, msg, wp, lp);
}

DWORD WINAPI uiThread(LPVOID ready) {
	static PFN_SetThreadDpiAwarenessContext setThread = [] {
		HMODULE user32 = GetModuleHandleW(L"user32.dll");
		return user32 ? (PFN_SetThreadDpiAwarenessContext)(void*)GetProcAddress(user32, "SetThreadDpiAwarenessContext")
		              : nullptr;
	}();
	if (setThread) setThread(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
	HINSTANCE inst = GetModuleHandleW(nullptr);
	WNDCLASSEXW fc{};
	fc.cbSize = sizeof fc;
	fc.lpfnWndProc = frameProc;
	fc.hInstance = inst;
	fc.lpszClassName = kFrameClass;
	RegisterClassExW(&fc);
	WNDCLASSEXW cc{};
	cc.cbSize = sizeof cc;
	cc.lpfnWndProc = ctrlProc;
	cc.hInstance = inst;
	cc.lpszClassName = kCtrlClass;
	RegisterClassExW(&cc);
	g_ctrl = CreateWindowExW(0, kCtrlClass, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, inst, nullptr);
	SetEvent((HANDLE)ready);
	MSG m;
	while (GetMessageW(&m, nullptr, 0, 0) > 0) {
		TranslateMessage(&m);
		DispatchMessageW(&m);
	}
	return 0;
}

int32_t ensureThread() {
	std::lock_guard<std::mutex> lock(g_startLock);
	if (g_ctrl) return GLIM_OK;
	HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
	if (!ready) {
		glimSetError("CreateEventW failed: %lu", GetLastError());
		return GLIM_E_API;
	}
	g_thread = CreateThread(nullptr, 0, uiThread, ready, 0, nullptr);
	if (!g_thread) {
		CloseHandle(ready);
		glimSetError("CreateThread failed: %lu", GetLastError());
		return GLIM_E_API;
	}
	DWORD w = WaitForSingleObject(ready, 5000);
	CloseHandle(ready);
	if (w != WAIT_OBJECT_0 || !g_ctrl) {
		glimSetError("frame UI thread did not start");
		return GLIM_E_TIMEOUT;
	}
	return GLIM_OK;
}

int32_t call(Call& c) {
	int32_t r = ensureThread();
	if (r != GLIM_OK) return r;
	c.status = GLIM_E_API;
	SendMessageW(g_ctrl, WM_GLIM_CALL, 0, (LPARAM)&c);
	return c.status;
}

}  // namespace

// Create a hidden frame window. *out = its handle (an id, not a pointer).
GLIM_EXPORT int32_t glim_frame_create(uint64_t* out) {
	if (!out) return GLIM_E_ARGS;
	Call c{kCreate, 0, nullptr, {0, 0, 0, 0}, nullptr, nullptr, 0, 0, nullptr, nullptr, nullptr, 0};
	int32_t r = call(c);
	*out = c.out;
	return r;
}

// rect = {x, y, w, h} of the pinned region in physical virtual-desktop px; scale = the
// display's DPI scale (1.5 at 144 dpi), so tick and tag sizes follow the UI scale.
GLIM_EXPORT int32_t glim_frame_set_rect(uint64_t frame, const double* rect, double scale) {
	if (!rect || !(rect[2] > 0) || !(rect[3] > 0)) {
		glimSetError("bad frame rect");
		return GLIM_E_ARGS;
	}
	double nums[5] = {rect[0], rect[1], rect[2], rect[3], scale};
	Call c{kRect, frame, nums, {0, 0, 0, 0}, nullptr, nullptr, 0, 0, nullptr, nullptr, nullptr, 0};
	return call(c);
}

// style: 0 running (accent ticks), 1 paused / error (picker-stroke at 60 %).
// palette: RGBA u32[7] = accent, picker-halo, picker-stroke, picker-hud, picker-hud-text,
// box-linked-fill, egress-dark (DESIGN.md tokens; null keeps the current ones).
// tag: 0 none, 1 live, 2 paused, 3 cloud (egress-dark text); tagText UTF-8.
GLIM_EXPORT int32_t glim_frame_set_style(uint64_t frame, int32_t style, const uint32_t* palette, int32_t tag,
                                         const char* tagText, int32_t tagBelow) {
	Call c{kStyle, frame, nullptr, {style, tag, tagBelow, 0}, palette, tagText, 0, 0, nullptr, nullptr, nullptr, 0};
	return call(c);
}

// The linked block's box in physical px (has = 0 removes it).
GLIM_EXPORT int32_t glim_frame_set_highlight(uint64_t frame, int32_t has, const double* rect) {
	if (has && !rect) return GLIM_E_ARGS;
	Call c{kHighlight, frame, rect, {has, 0, 0, 0}, nullptr, nullptr, 0, 0, nullptr, nullptr, nullptr, 0};
	return call(c);
}

// Show (without activating, HWND_TOPMOST) or hide.
GLIM_EXPORT int32_t glim_frame_show(uint64_t frame, int32_t visible) {
	Call c{kShow, frame, nullptr, {visible, 0, 0, 0}, nullptr, nullptr, 0, 0, nullptr, nullptr, nullptr, 0};
	return call(c);
}

// GLIM-154: the badges and cards over the region. count sprites; geom f64[count * 5] = x, y,
// w, h (physical px), opacity; meta i32[count * 3] = pixel width, pixel height, flags (1
// interactive: hit-tested, the window catches clicks over it; 2 peek: drops to `peek` opacity
// while hovered); pixels: premultiplied RGBA, the sprites back to back, `bytes` long. Replaces
// the previous set; count 0 removes them all.
GLIM_EXPORT int32_t glim_frame_set_sprites(uint64_t frame, int32_t count, const double* geom, const int32_t* meta,
                                           const uint8_t* pixels, int64_t bytes, double peek) {
	if (count < 0 || (count > 0 && (!geom || !meta || !pixels))) return GLIM_E_ARGS;
	double nums[1] = {peek};
	Call c{kSprites, frame, nums, {count, 0, 0, 0}, nullptr, nullptr, 0, 0, geom, meta, pixels, bytes};
	return call(c);
}

// GLIM-154: out i32[2] = the interactive sprite under the cursor (-1 none), and the sprite
// clicked since the last call (-1 none).
GLIM_EXPORT int32_t glim_frame_pointer(uint64_t frame, int32_t* out) {
	if (!out) return GLIM_E_ARGS;
	Call c{kPointer, frame, nullptr, {0, 0, 0, 0}, nullptr, nullptr, 0, 0, nullptr, nullptr, nullptr, 0};
	int32_t r = call(c);
	out[0] = (int32_t)(uint32_t)(c.out & 0xFFFFFFFFu);
	out[1] = (int32_t)(uint32_t)(c.out >> 32);
	return r;
}

// The frame's HWND value (diagnostics; WDA_EXCLUDEFROMCAPTURE already keeps it out of captures).
GLIM_EXPORT int32_t glim_frame_window_id(uint64_t frame, uint64_t* out) {
	if (!out) return GLIM_E_ARGS;
	Call c{kWindowId, frame, nullptr, {0, 0, 0, 0}, nullptr, nullptr, 0, 0, nullptr, nullptr, nullptr, 0};
	int32_t r = call(c);
	*out = c.out;
	return r;
}

// Diagnostics / smoke tests: JSON with what the OS reports for the frame window:
// {"exStyle":N,"affinity":N,"affinityError":N,"visible":0|1,"x":..,"y":..,"w":..,"h":..,"clickThrough":0|1}.
// affinityError (GLIM-163): GetLastError() of the last failed SetWindowDisplayAffinity, or 0.
// clickThrough: WindowFromPoint at a tick's pixel does NOT return the frame (hit-testing
// skips WS_EX_TRANSPARENT layered windows), i.e. a click there reaches the app below.
GLIM_EXPORT int32_t glim_frame_info(uint64_t frame, char* buf, int32_t cap) {
	Call c{kWindowId, frame, nullptr, {0, 0, 0, 0}, nullptr, nullptr, 0, 0, nullptr, nullptr, nullptr, 0};
	int32_t r = call(c);
	if (r != GLIM_OK) return -1;
	HWND hwnd = (HWND)(uintptr_t)c.out;
	RECT rc{};
	GetWindowRect(hwnd, &rc);
	DWORD affinity = 0;
	GetWindowDisplayAffinity(hwnd, &affinity);
	LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
	// A pixel on the top-left tick: 16 px margin (scaled) minus the 3 px tick offset, roughly.
	POINT probe{rc.left + (rc.right - rc.left > 20 ? 14 : 0), rc.bottom - 14};
	HWND hit = WindowFromPoint(probe);
	char out[288];
	snprintf(out, sizeof out,
	         "{\"exStyle\":%lld,\"affinity\":%lu,\"affinityError\":%lu,\"visible\":%d,\"x\":%ld,\"y\":%ld,\"w\":%ld,\"h\":%ld,"
	         "\"clickThrough\":%d}",
	         (long long)ex, (unsigned long)affinity, (unsigned long)(uint32_t)c.ints[0], IsWindowVisible(hwnd) ? 1 : 0,
	         rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top, hit != hwnd ? 1 : 0);
	return glimCopyOut(out, buf, cap);
}

GLIM_EXPORT int32_t glim_frame_destroy(uint64_t frame) {
	Call c{kDestroy, frame, nullptr, {0, 0, 0, 0}, nullptr, nullptr, 0, 0, nullptr, nullptr, nullptr, 0};
	return call(c);
}
