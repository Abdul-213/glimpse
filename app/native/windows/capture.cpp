// Screen capture for glimpse.dll. Ported from spikes/capture/native/windows/glimcapture.cpp.
//
//   backend 1  GDI BitBlt(SRCCOPY | CAPTUREBLT) from the screen DC. No session, robust:
//              the Snip path, and the fallback when DXGI is unavailable.
//   backend 2  DXGI Desktop Duplication, one persistent duplication per monitor: the
//              Live path. Cheap once warm; AcquireNextFrame only returns on change, so a
//              static screen costs a GPU->CPU copy of the region and nothing else.
//
// WGC (Windows.Graphics.Capture) from the spike is not ported: it draws a border around
// the whole monitor that an unpackaged app can't remove (spikes/capture/FINDINGS.md).
//
// Self-capture exclusion needs nothing here: SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
// is called from TypeScript on every Glimpse HWND, and the DWM leaves those windows out
// of everything GDI and DXGI read.
//
// Coordinates are physical pixels (per-monitor-DPI-aware v2). Pixels are written as
// RGBA8 (alpha 255) straight into the caller's buffer, swizzled from BGRA while copying,
// and resampled bilinearly when the destination size differs from the source size
// (a region spanning monitors with different scale factors).
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "glimpse.h"

enum : int32_t { BK_ALL = 0, BK_GDI = 1, BK_DXGI = 2 };

template <class T> static void safeRelease(T*& p) {
	if (p) {
		p->Release();
		p = nullptr;
	}
}

// ---------------------------------------------------------------------------
// DPI awareness + monitors

typedef DPI_AWARENESS_CONTEXT(WINAPI* PFN_SetThreadDpiAwarenessContext)(DPI_AWARENESS_CONTEXT);
typedef HRESULT(WINAPI* PFN_GetDpiForMonitor)(HMONITOR, int, UINT*, UINT*);

// Electrobun makes the process per-monitor-v2 aware. Force it on the calling thread too
// so GDI and monitor rects are physical even if the Bun worker thread started earlier.
static void ensureDpiAware() {
	static PFN_SetThreadDpiAwarenessContext setThread = [] {
		HMODULE user32 = GetModuleHandleW(L"user32.dll");
		return user32 ? (PFN_SetThreadDpiAwarenessContext)(void*)GetProcAddress(user32, "SetThreadDpiAwarenessContext")
		              : nullptr;
	}();
	if (setThread) setThread(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
}

struct Monitor {
	HMONITOR handle;
	RECT rect; // physical
	UINT dpi;
	bool primary;
	std::wstring device;
};

static BOOL CALLBACK enumMonProc(HMONITOR m, HDC, LPRECT, LPARAM lp) {
	auto* v = (std::vector<Monitor>*)lp;
	MONITORINFOEXW mi{};
	mi.cbSize = sizeof mi;
	if (!GetMonitorInfoW(m, &mi)) return TRUE;
	UINT dx = 96, dy = 96;
	static PFN_GetDpiForMonitor getDpi = [] {
		HMODULE sh = LoadLibraryW(L"shcore.dll");
		return sh ? (PFN_GetDpiForMonitor)(void*)GetProcAddress(sh, "GetDpiForMonitor") : nullptr;
	}();
	if (getDpi) getDpi(m, 0 /*MDT_EFFECTIVE_DPI*/, &dx, &dy);
	v->push_back({m, mi.rcMonitor, dx, (mi.dwFlags & MONITORINFOF_PRIMARY) != 0, mi.szDevice});
	return TRUE;
}

static std::vector<Monitor> monitors() {
	ensureDpiAware();
	std::vector<Monitor> v;
	EnumDisplayMonitors(nullptr, nullptr, enumMonProc, (LPARAM)&v);
	return v;
}

static std::string narrow(const std::wstring& w) {
	if (w.empty()) return {};
	int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
	std::string s(n, 0);
	WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
	return s;
}

static std::string jsonEscape(const std::string& s) {
	std::string o;
	for (char c : s) {
		if (c == '"' || c == '\\') {
			o += '\\';
			o += c;
		} else if ((unsigned char)c < 0x20) {
			o += ' ';
		} else {
			o += c;
		}
	}
	return o;
}

// ---------------------------------------------------------------------------
// Pixel copy: strided BGRA source (sw x sh) -> RGBA dest sub-rect (dw x dh), alpha 255.

static void copyBgraToRgba(const uint8_t* src, int srcPitch, int sw, int sh, uint8_t* out, int outStride, int dx,
	int dy, int dw, int dh) {
	if (sw == dw && sh == dh) {
		for (int y = 0; y < dh; y++) {
			const uint8_t* s = src + (size_t)y * srcPitch;
			uint8_t* d = out + (size_t)(dy + y) * outStride + (size_t)dx * 4;
			for (int x = 0; x < dw; x++, s += 4, d += 4) {
				d[0] = s[2];
				d[1] = s[1];
				d[2] = s[0];
				d[3] = 255;
			}
		}
		return;
	}
	// Bilinear with pixel centres aligned; matches blitRgba in packages/core.
	const double fx = (double)sw / dw;
	const double fy = (double)sh / dh;
	for (int y = 0; y < dh; y++) {
		double syf = (y + 0.5) * fy - 0.5;
		if (syf < 0) syf = 0;
		if (syf > sh - 1) syf = sh - 1;
		int y0 = (int)syf;
		int y1 = y0 + 1 < sh ? y0 + 1 : sh - 1;
		double wy = syf - y0;
		const uint8_t* r0 = src + (size_t)y0 * srcPitch;
		const uint8_t* r1 = src + (size_t)y1 * srcPitch;
		uint8_t* d = out + (size_t)(dy + y) * outStride + (size_t)dx * 4;
		for (int x = 0; x < dw; x++, d += 4) {
			double sxf = (x + 0.5) * fx - 0.5;
			if (sxf < 0) sxf = 0;
			if (sxf > sw - 1) sxf = sw - 1;
			int x0 = (int)sxf;
			int x1 = x0 + 1 < sw ? x0 + 1 : sw - 1;
			double wx = sxf - x0;
			for (int c = 0; c < 3; c++) {
				double a = r0[x0 * 4 + c], b = r0[x1 * 4 + c], cc = r1[x0 * 4 + c], e = r1[x1 * 4 + c];
				double top = a + (b - a) * wx;
				double bot = cc + (e - cc) * wx;
				d[2 - c] = (uint8_t)std::lround(top + (bot - top) * wy); // BGRA c -> RGBA 2-c
			}
			d[3] = 255;
		}
	}
}

// ---------------------------------------------------------------------------
// GDI

struct GdiCache {
	HDC screen = nullptr, mem = nullptr;
	HBITMAP dib = nullptr, old = nullptr;
	void* bits = nullptr;
	int w = 0, h = 0;
	void reset() {
		if (mem && old) SelectObject(mem, old);
		if (dib) DeleteObject(dib);
		if (mem) DeleteDC(mem);
		if (screen) ReleaseDC(nullptr, screen);
		*this = GdiCache{};
	}
};
static GdiCache g_gdi;
static uint64_t g_gdiSeq = 0;

static int32_t captureGdi(int gx, int gy, int sw, int sh, uint8_t* out, int outStride, int dx, int dy, int dw, int dh,
	uint64_t* seq) {
	if (g_gdi.w != sw || g_gdi.h != sh || !g_gdi.screen) {
		g_gdi.reset();
		g_gdi.screen = GetDC(nullptr);
		if (!g_gdi.screen) {
			glimSetError("GetDC(NULL) failed (%lu)", GetLastError());
			return GLIM_E_API;
		}
		g_gdi.mem = CreateCompatibleDC(g_gdi.screen);
		BITMAPINFO bi{};
		bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
		bi.bmiHeader.biWidth = sw;
		bi.bmiHeader.biHeight = -sh; // top-down
		bi.bmiHeader.biPlanes = 1;
		bi.bmiHeader.biBitCount = 32;
		bi.bmiHeader.biCompression = BI_RGB;
		g_gdi.dib = CreateDIBSection(g_gdi.screen, &bi, DIB_RGB_COLORS, &g_gdi.bits, nullptr, 0);
		if (!g_gdi.mem || !g_gdi.dib || !g_gdi.bits) {
			glimSetError("CreateDIBSection %dx%d failed (%lu)", sw, sh, GetLastError());
			g_gdi.reset();
			return GLIM_E_API;
		}
		g_gdi.old = (HBITMAP)SelectObject(g_gdi.mem, g_gdi.dib);
		g_gdi.w = sw;
		g_gdi.h = sh;
	}
	// CAPTUREBLT includes layered windows (other apps' overlays). WDA_EXCLUDEFROMCAPTURE
	// windows are still left out (Windows 10 2004+).
	if (!BitBlt(g_gdi.mem, 0, 0, sw, sh, g_gdi.screen, gx, gy, SRCCOPY | CAPTUREBLT)) {
		DWORD e = GetLastError();
		glimSetError("BitBlt failed (%lu)", e);
		// ERROR_ACCESS_DENIED while the secure desktop (UAC, lock screen) is up.
		return e == ERROR_ACCESS_DENIED ? (int32_t)E_ACCESSDENIED : GLIM_E_API;
	}
	GdiFlush();
	copyBgraToRgba((const uint8_t*)g_gdi.bits, sw * 4, sw, sh, out, outStride, dx, dy, dw, dh);
	if (seq) *seq = ++g_gdiSeq; // GDI can't tell whether anything changed
	return GLIM_OK;
}

// ---------------------------------------------------------------------------
// D3D11 readback of a sub-rect of a GPU texture into the caller's buffer.

struct Staging {
	ID3D11Texture2D* tex = nullptr;
	int w = 0, h = 0;
	void reset() {
		safeRelease(tex);
		w = h = 0;
	}
};

static int32_t readbackRegion(ID3D11Device* dev, ID3D11DeviceContext* ctx, ID3D11Texture2D* src, Staging& st, int lx,
	int ly, int sw, int sh, uint8_t* out, int outStride, int dx, int dy, int dw, int dh) {
	if (!src) {
		glimSetError("DXGI: no frame texture");
		return GLIM_E_NO_FRAME;
	}
	D3D11_TEXTURE2D_DESC sd;
	src->GetDesc(&sd);
	if (lx < 0 || ly < 0 || lx + sw > (int)sd.Width || ly + sh > (int)sd.Height) {
		glimSetError("region %d,%d %dx%d outside monitor texture %ux%u", lx, ly, sw, sh, sd.Width, sd.Height);
		return GLIM_E_ARGS;
	}
	if (sd.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
		glimSetError("unexpected texture format %d (expected BGRA8; HDR output?)", (int)sd.Format);
		return GLIM_E_UNSUPPORTED;
	}
	if (!st.tex || st.w != sw || st.h != sh) {
		st.reset();
		D3D11_TEXTURE2D_DESC d{};
		d.Width = sw;
		d.Height = sh;
		d.MipLevels = 1;
		d.ArraySize = 1;
		d.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
		d.SampleDesc.Count = 1;
		d.Usage = D3D11_USAGE_STAGING;
		d.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
		HRESULT hr = dev->CreateTexture2D(&d, nullptr, &st.tex);
		if (FAILED(hr)) {
			glimSetError("CreateTexture2D(staging) hr=0x%08lx", (unsigned long)hr);
			return (int32_t)hr;
		}
		st.w = sw;
		st.h = sh;
	}
	D3D11_BOX box{(UINT)lx, (UINT)ly, 0, (UINT)(lx + sw), (UINT)(ly + sh), 1};
	ctx->CopySubresourceRegion(st.tex, 0, 0, 0, 0, src, 0, &box);
	D3D11_MAPPED_SUBRESOURCE m;
	HRESULT hr = ctx->Map(st.tex, 0, D3D11_MAP_READ, 0, &m);
	if (FAILED(hr)) {
		glimSetError("Map(staging) hr=0x%08lx", (unsigned long)hr);
		return (int32_t)hr;
	}
	copyBgraToRgba((const uint8_t*)m.pData, (int)m.RowPitch, sw, sh, out, outStride, dx, dy, dw, dh);
	ctx->Unmap(st.tex, 0);
	return GLIM_OK;
}

static ID3D11Texture2D* makeCopyTarget(ID3D11Device* dev, UINT w, UINT h) {
	D3D11_TEXTURE2D_DESC d{};
	d.Width = w;
	d.Height = h;
	d.MipLevels = 1;
	d.ArraySize = 1;
	d.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
	d.SampleDesc.Count = 1;
	d.Usage = D3D11_USAGE_DEFAULT;
	ID3D11Texture2D* t = nullptr;
	dev->CreateTexture2D(&d, nullptr, &t);
	return t;
}

// ---------------------------------------------------------------------------
// DXGI Desktop Duplication

struct DxgiSession {
	ID3D11Device* dev = nullptr;
	ID3D11DeviceContext* ctx = nullptr;
	IDXGIOutputDuplication* dup = nullptr;
	ID3D11Texture2D* last = nullptr; // copy of the most recent desktop image
	Staging st;
	bool haveFrame = false;
	uint64_t contentSeq = 0; // bumps when the desktop image changed
	void reset() {
		st.reset();
		safeRelease(last);
		safeRelease(dup);
		safeRelease(ctx);
		safeRelease(dev);
		haveFrame = false;
	}
};
static std::map<HMONITOR, DxgiSession> g_dxgi;

static int32_t dxgiOpen(HMONITOR mon, DxgiSession& s) {
	IDXGIFactory1* factory = nullptr;
	HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory);
	if (FAILED(hr)) {
		glimSetError("CreateDXGIFactory1 hr=0x%08lx", (unsigned long)hr);
		return (int32_t)hr;
	}
	IDXGIAdapter1* adapter = nullptr;
	IDXGIOutput* output = nullptr;
	// The duplication must be created on the adapter that owns the output
	// (hybrid-GPU laptops return DXGI_ERROR_UNSUPPORTED otherwise).
	for (UINT i = 0; !output && factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; i++) {
		IDXGIOutput* o = nullptr;
		for (UINT j = 0; adapter->EnumOutputs(j, &o) != DXGI_ERROR_NOT_FOUND; j++) {
			DXGI_OUTPUT_DESC od;
			o->GetDesc(&od);
			if (od.Monitor == mon) {
				output = o;
				break;
			}
			o->Release();
		}
		if (!output) safeRelease(adapter);
	}
	factory->Release();
	if (!output) {
		glimSetError("no DXGI output for monitor %p", (void*)mon);
		return GLIM_E_NO_DISPLAY;
	}
	if (!s.dev) {
		D3D_FEATURE_LEVEL fl;
		hr = D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
			D3D11_SDK_VERSION, &s.dev, &fl, &s.ctx);
		if (FAILED(hr)) {
			output->Release();
			adapter->Release();
			glimSetError("D3D11CreateDevice hr=0x%08lx", (unsigned long)hr);
			return (int32_t)hr;
		}
	}
	adapter->Release();
	IDXGIOutput1* out1 = nullptr;
	hr = output->QueryInterface(__uuidof(IDXGIOutput1), (void**)&out1);
	output->Release();
	if (FAILED(hr)) {
		glimSetError("IDXGIOutput1 not available hr=0x%08lx", (unsigned long)hr);
		return GLIM_E_UNSUPPORTED;
	}
	hr = out1->DuplicateOutput(s.dev, &s.dup);
	out1->Release();
	if (FAILED(hr)) {
		// E_ACCESSDENIED: secure desktop (UAC / lock screen). DXGI_ERROR_UNSUPPORTED: wrong
		// adapter, remote session, basic display driver. DXGI_ERROR_NOT_CURRENTLY_AVAILABLE:
		// too many duplications of this output.
		glimSetError("DuplicateOutput hr=0x%08lx", (unsigned long)hr);
		return (int32_t)hr;
	}
	DXGI_OUTDUPL_DESC dd;
	s.dup->GetDesc(&dd);
	if (dd.Rotation != DXGI_MODE_ROTATION_IDENTITY && dd.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) {
		// The duplicated image is unrotated; mapping regions onto it isn't implemented.
		// The TypeScript side falls back to GDI, which handles rotation.
		glimSetError("rotated output (rotation=%d) is not handled by DXGI capture", (int)dd.Rotation);
		safeRelease(s.dup);
		return GLIM_E_UNSUPPORTED;
	}
	if (!s.last) s.last = makeCopyTarget(s.dev, dd.ModeDesc.Width, dd.ModeDesc.Height);
	return GLIM_OK;
}

static int32_t captureDxgi(HMONITOR mon, int lx, int ly, int sw, int sh, uint8_t* out, int outStride, int dx, int dy,
	int dw, int dh, uint64_t* seq) {
	DxgiSession& s = g_dxgi[mon];
	for (int attempt = 0; attempt < 2; attempt++) {
		if (!s.dup) {
			int32_t r = dxgiOpen(mon, s);
			if (r != GLIM_OK) return r;
		}
		DXGI_OUTDUPL_FRAME_INFO info;
		IDXGIResource* res = nullptr;
		// Wait only for the very first frame; afterwards reuse the last image when the
		// desktop hasn't changed (AcquireNextFrame only returns on change).
		HRESULT hr = s.dup->AcquireNextFrame(s.haveFrame ? 0 : 500, &info, &res);
		if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
			if (!s.haveFrame) {
				glimSetError("DXGI: no first frame within 500 ms");
				return GLIM_E_NO_FRAME;
			}
			break;
		}
		if (hr == DXGI_ERROR_ACCESS_LOST || hr == DXGI_ERROR_INVALID_CALL) {
			// Mode change, fullscreen switch, desktop switch: recreate once, and wait for a
			// fresh first frame (the old image may have the wrong size now).
			safeRelease(s.dup);
			s.haveFrame = false;
			if (attempt == 1) {
				glimSetError("DXGI: access lost twice hr=0x%08lx", (unsigned long)hr);
				return (int32_t)hr;
			}
			continue;
		}
		if (FAILED(hr)) {
			glimSetError("AcquireNextFrame hr=0x%08lx", (unsigned long)hr);
			return (int32_t)hr;
		}
		// LastPresentTime == 0 means only the mouse pointer moved: the image is unchanged.
		bool imageChanged = info.LastPresentTime.QuadPart != 0 || !s.haveFrame;
		ID3D11Texture2D* tex = nullptr;
		hr = res->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&tex);
		res->Release();
		if (SUCCEEDED(hr) && imageChanged) {
			D3D11_TEXTURE2D_DESC td;
			tex->GetDesc(&td);
			if (s.last) {
				D3D11_TEXTURE2D_DESC ld;
				s.last->GetDesc(&ld);
				if (td.Width != ld.Width || td.Height != ld.Height) safeRelease(s.last);
			}
			if (!s.last) s.last = makeCopyTarget(s.dev, td.Width, td.Height);
			if (s.last) s.ctx->CopyResource(s.last, tex);
			s.haveFrame = s.last != nullptr;
			s.contentSeq++;
		}
		if (tex) tex->Release();
		s.dup->ReleaseFrame();
		break;
	}
	if (!s.haveFrame) {
		glimSetError("DXGI: no frame");
		return GLIM_E_NO_FRAME;
	}
	int32_t r = readbackRegion(s.dev, s.ctx, s.last, s.st, lx, ly, sw, sh, out, outStride, dx, dy, dw, dh);
	if (r == GLIM_OK && seq) *seq = s.contentSeq;
	return r;
}

// ---------------------------------------------------------------------------
// C ABI

// {"displays":[{"id":<HMONITOR>,"name":"\\\\.\\DISPLAY1","bounds":{x,y,width,height},"dpi":144,"primary":true}]}
// Bounds are physical virtual-desktop pixels. id equals Electrobun's Display.id.
GLIM_EXPORT int32_t glim_capture_displays_json(char* buf, int32_t cap) {
	auto ms = monitors();
	std::string j = "{\"displays\":[";
	for (size_t i = 0; i < ms.size(); i++) {
		const auto& m = ms[i];
		char b[512];
		snprintf(b, sizeof b,
			"%s{\"id\":%llu,\"name\":\"%s\",\"bounds\":{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld},"
			"\"dpi\":%u,\"primary\":%s}",
			i ? "," : "", (unsigned long long)(uintptr_t)m.handle, jsonEscape(narrow(m.device)).c_str(), m.rect.left,
			m.rect.top, m.rect.right - m.rect.left, m.rect.bottom - m.rect.top, m.dpi, m.primary ? "true" : "false");
		j += b;
	}
	j += "]}";
	return glimCopyOut(j, buf, cap);
}

// Capture one per-monitor piece of a region into `out` (RGBA8, row stride `outStride`,
// `outLen` bytes in total).
//   geom[10] = gx, gy        global physical origin of the source (GDI)
//              lx, ly        same origin relative to the monitor's top-left (DXGI)
//              sw, sh        source size in physical px
//              dx, dy, dw, dh destination rect in `out`; resampled when != sw x sh
//   seqOut   = content sequence (DXGI: unchanged while the desktop is unchanged;
//              GDI: increments on every call). May be NULL.
GLIM_EXPORT int32_t glim_capture_piece(int32_t backend, uint64_t monitor, const int32_t* geom, uint8_t* out,
	int32_t outStride, uint64_t outLen, uint64_t* seqOut) {
	ensureDpiAware();
	if (!geom || !out) {
		glimSetError("null geometry or output buffer");
		return GLIM_E_ARGS;
	}
	const int gx = geom[0], gy = geom[1], lx = geom[2], ly = geom[3], sw = geom[4], sh = geom[5];
	const int dx = geom[6], dy = geom[7], dw = geom[8], dh = geom[9];
	if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0 || dx < 0 || dy < 0 || outStride < (dx + dw) * 4 ||
		(uint64_t)outStride * (uint64_t)(dy + dh) > outLen) {
		glimSetError("bad geometry: src %dx%d dest %d,%d %dx%d stride=%d len=%llu", sw, sh, dx, dy, dw, dh, outStride,
			(unsigned long long)outLen);
		return GLIM_E_ARGS;
	}
	HMONITOR mon = (HMONITOR)(uintptr_t)monitor;
	switch (backend) {
	case BK_GDI: return captureGdi(gx, gy, sw, sh, out, outStride, dx, dy, dw, dh, seqOut);
	case BK_DXGI: return captureDxgi(mon, lx, ly, sw, sh, out, outStride, dx, dy, dw, dh, seqOut);
	default: glimSetError("unknown backend %d", backend); return GLIM_E_BACKEND;
	}
}

// Release cached capture state: 0 = everything, 1 = GDI DC/DIB, 2 = all DXGI duplications
// (call when the last Live session closes so the GPU devices go away).
GLIM_EXPORT void glim_capture_release(int32_t backend) {
	if (backend == BK_ALL || backend == BK_GDI) g_gdi.reset();
	if (backend == BK_ALL || backend == BK_DXGI) {
		for (auto& kv : g_dxgi) kv.second.reset();
		g_dxgi.clear();
	}
}
