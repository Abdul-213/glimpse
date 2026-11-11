// GLIM-15 spike: Windows region capture behind a tiny C ABI, loaded by Bun via
// bun:ffi (dlopen). Three backends so they can be compared on the same machine:
//
//   10  GDI BitBlt(SRCCOPY|CAPTUREBLT) from the screen DC        (baseline)
//   11  DXGI Desktop Duplication, one persistent session/output  (IDXGIOutput1)
//   12  Windows.Graphics.Capture, one persistent session/monitor (raw WinRT ABI)
//
// Pixels are written straight into the caller's (Bun-owned) buffer, swizzled
// BGRA -> RGBA while copying rows out of the GDI DIB / D3D11 staging texture.
// No intermediate heap copy, no IPC.
//
// WinRT is used through hand-declared ABI interfaces (IIDs checked against the
// windows-rs metadata, see FINDINGS.md) so the DLL builds with MSVC *or*
// zig/mingw without C++/WinRT headers. combase functions are resolved at
// runtime, so the DLL loads on any Windows 10+.
//
// Build: native/windows/build.ps1 (MSVC) or build-zig.sh / build-zig.ps1 (zig).

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <inspectable.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cstdarg>
#include <map>
#include <string>
#include <vector>

#define GC_EXPORT extern "C" __declspec(dllexport)

// ---------------------------------------------------------------------------
// Error reporting

static std::string g_err;
static void setErr(const char* fmt, ...) {
	char buf[1024];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(buf, sizeof buf, fmt, ap);
	va_end(ap);
	g_err = buf;
}

static int32_t copyOut(const std::string& s, char* buf, int32_t cap) {
	if (buf && cap > 0) {
		size_t n = s.size() < (size_t)(cap - 1) ? s.size() : (size_t)(cap - 1);
		memcpy(buf, s.data(), n);
		buf[n] = 0;
	}
	return (int32_t)s.size();
}

template <class T> static void safeRelease(T*& p) {
	if (p) {
		p->Release();
		p = nullptr;
	}
}

enum : int32_t {
	GC_OK = 0,
	GC_E_ARGS = -1,
	GC_E_NO_DISPLAY = -2,
	GC_E_UNSUPPORTED = -3,
	GC_E_API = -4,
	GC_E_NO_FRAME = -5,
	GC_E_BACKEND = -6,
};

enum : int32_t { BK_GDI = 10, BK_DXGI = 11, BK_WGC = 12 };
enum : int32_t { OPT_CURSOR = 1, OPT_WGC_BORDER = 2, OPT_CAPTUREBLT = 5 };

static bool g_optCursor = false;
static bool g_optBorder = true; // WGC default: border on (the OS default)
static bool g_optCaptureBlt = true;

// ---------------------------------------------------------------------------
// DPI awareness + monitors

typedef DPI_AWARENESS_CONTEXT(WINAPI* PFN_SetThreadDpiAwarenessContext)(DPI_AWARENESS_CONTEXT);
typedef BOOL(WINAPI* PFN_SetProcessDpiAwarenessContext)(DPI_AWARENESS_CONTEXT);
typedef HRESULT(WINAPI* PFN_GetDpiForMonitor)(HMONITOR, int, UINT*, UINT*);

static std::string g_dpiMode = "unknown";

static void ensureDpiAware() {
	static bool once = false;
	HMODULE user32 = GetModuleHandleW(L"user32.dll");
	if (!once) {
		once = true;
		auto setProc = (PFN_SetProcessDpiAwarenessContext)GetProcAddress(user32, "SetProcessDpiAwarenessContext");
		if (setProc && setProc(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
			g_dpiMode = "process set to PMv2 by glimcapture";
		} else {
			g_dpiMode = "process awareness already set (e.g. by Electrobun) or unsupported; thread forced to PMv2";
		}
	}
	// Belt and braces: every entry point runs on the calling thread with PMv2,
	// so GDI/monitor coordinates are physical even if the process is unaware.
	auto setThread = (PFN_SetThreadDpiAwarenessContext)GetProcAddress(user32, "SetThreadDpiAwarenessContext");
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
		return sh ? (PFN_GetDpiForMonitor)GetProcAddress(sh, "GetDpiForMonitor") : nullptr;
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
// Pixel copy: strided BGRA -> packed-into-dest RGBA, alpha forced to 255.

static void copyBgraToRgba(const uint8_t* src, int srcPitch, int w, int h, uint8_t* out, int outStride, int dx, int dy) {
	for (int y = 0; y < h; y++) {
		const uint8_t* s = src + (size_t)y * srcPitch;
		uint8_t* d = out + (size_t)(dy + y) * outStride + (size_t)dx * 4;
		for (int x = 0; x < w; x++, s += 4, d += 4) {
			d[0] = s[2];
			d[1] = s[1];
			d[2] = s[0];
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
} g_gdi;

static int32_t captureGdi(int gx, int gy, int w, int h, uint8_t* out, int outStride, int dx, int dy) {
	if (g_gdi.w != w || g_gdi.h != h || !g_gdi.screen) {
		g_gdi.reset();
		g_gdi.screen = GetDC(nullptr);
		g_gdi.mem = CreateCompatibleDC(g_gdi.screen);
		BITMAPINFO bi{};
		bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
		bi.bmiHeader.biWidth = w;
		bi.bmiHeader.biHeight = -h; // top-down
		bi.bmiHeader.biPlanes = 1;
		bi.bmiHeader.biBitCount = 32;
		bi.bmiHeader.biCompression = BI_RGB;
		g_gdi.dib = CreateDIBSection(g_gdi.screen, &bi, DIB_RGB_COLORS, &g_gdi.bits, nullptr, 0);
		if (!g_gdi.dib || !g_gdi.bits) {
			setErr("CreateDIBSection failed (%lu)", GetLastError());
			g_gdi.reset();
			return GC_E_API;
		}
		g_gdi.old = (HBITMAP)SelectObject(g_gdi.mem, g_gdi.dib);
		g_gdi.w = w;
		g_gdi.h = h;
	}
	DWORD rop = SRCCOPY | (g_optCaptureBlt ? CAPTUREBLT : 0);
	if (!BitBlt(g_gdi.mem, 0, 0, w, h, g_gdi.screen, gx, gy, rop)) {
		setErr("BitBlt failed (%lu)", GetLastError());
		return GC_E_API;
	}
	GdiFlush();
	copyBgraToRgba((const uint8_t*)g_gdi.bits, w * 4, w, h, out, outStride, dx, dy);
	return GC_OK;
}

// ---------------------------------------------------------------------------
// Shared D3D11 helper: copy a sub-rect of a GPU texture to the caller's buffer.

struct Staging {
	ID3D11Texture2D* tex = nullptr;
	int w = 0, h = 0;
	void reset() {
		safeRelease(tex);
		w = h = 0;
	}
};

static int32_t readbackRegion(ID3D11Device* dev, ID3D11DeviceContext* ctx, ID3D11Texture2D* src, Staging& st, int lx, int ly, int w, int h, uint8_t* out, int outStride, int dx, int dy) {
	if (!src) {
		setErr("no source texture (frame copy target could not be created)");
		return GC_E_NO_FRAME;
	}
	D3D11_TEXTURE2D_DESC sd;
	src->GetDesc(&sd);
	if (lx < 0 || ly < 0 || lx + w > (int)sd.Width || ly + h > (int)sd.Height) {
		setErr("region %d,%d %dx%d outside texture %ux%u", lx, ly, w, h, sd.Width, sd.Height);
		return GC_E_ARGS;
	}
	if (sd.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
		setErr("unexpected texture format %d (expected BGRA8)", (int)sd.Format);
		return GC_E_UNSUPPORTED;
	}
	if (!st.tex || st.w != w || st.h != h) {
		st.reset();
		D3D11_TEXTURE2D_DESC d{};
		d.Width = w;
		d.Height = h;
		d.MipLevels = 1;
		d.ArraySize = 1;
		d.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
		d.SampleDesc.Count = 1;
		d.Usage = D3D11_USAGE_STAGING;
		d.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
		HRESULT hr = dev->CreateTexture2D(&d, nullptr, &st.tex);
		if (FAILED(hr)) {
			setErr("CreateTexture2D(staging) hr=0x%08lx", (unsigned long)hr);
			return GC_E_API;
		}
		st.w = w;
		st.h = h;
	}
	D3D11_BOX box{(UINT)lx, (UINT)ly, 0, (UINT)(lx + w), (UINT)(ly + h), 1};
	ctx->CopySubresourceRegion(st.tex, 0, 0, 0, 0, src, 0, &box);
	D3D11_MAPPED_SUBRESOURCE m;
	HRESULT hr = ctx->Map(st.tex, 0, D3D11_MAP_READ, 0, &m);
	if (FAILED(hr)) {
		setErr("Map(staging) hr=0x%08lx", (unsigned long)hr);
		return GC_E_API;
	}
	copyBgraToRgba((const uint8_t*)m.pData, (int)m.RowPitch, w, h, out, outStride, dx, dy);
	ctx->Unmap(st.tex, 0);
	return GC_OK;
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
	ID3D11Texture2D* last = nullptr; // copy of most recent desktop image
	Staging st;
	bool haveFrame = false;
	uint64_t framesAcquired = 0, timeouts = 0, accessLost = 0, recreated = 0;
	void releaseDup() {
		safeRelease(dup);
	}
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
		setErr("CreateDXGIFactory1 hr=0x%08lx", (unsigned long)hr);
		return GC_E_API;
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
		setErr("no DXGI output for monitor %p", (void*)mon);
		return GC_E_NO_DISPLAY;
	}
	if (!s.dev) {
		D3D_FEATURE_LEVEL fl;
		hr = D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &s.dev, &fl, &s.ctx);
		if (FAILED(hr)) {
			output->Release();
			adapter->Release();
			setErr("D3D11CreateDevice hr=0x%08lx", (unsigned long)hr);
			return GC_E_API;
		}
	}
	adapter->Release();
	IDXGIOutput1* out1 = nullptr;
	hr = output->QueryInterface(__uuidof(IDXGIOutput1), (void**)&out1);
	output->Release();
	if (FAILED(hr)) {
		setErr("IDXGIOutput1 not available hr=0x%08lx", (unsigned long)hr);
		return GC_E_UNSUPPORTED;
	}
	hr = out1->DuplicateOutput(s.dev, &s.dup);
	out1->Release();
	if (FAILED(hr)) {
		// E_ACCESSDENIED: secure desktop (UAC / lock screen); DXGI_ERROR_UNSUPPORTED:
		// wrong adapter or remote session; DXGI_ERROR_NOT_CURRENTLY_AVAILABLE: too many duplications.
		setErr("DuplicateOutput hr=0x%08lx", (unsigned long)hr);
		return GC_E_API;
	}
	DXGI_OUTDUPL_DESC dd;
	s.dup->GetDesc(&dd);
	if (dd.Rotation != DXGI_MODE_ROTATION_IDENTITY && dd.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) {
		setErr("rotated output (rotation=%d) not handled in this spike", (int)dd.Rotation);
		s.releaseDup();
		return GC_E_UNSUPPORTED;
	}
	if (!s.last) s.last = makeCopyTarget(s.dev, dd.ModeDesc.Width, dd.ModeDesc.Height);
	return GC_OK;
}

static int32_t captureDxgi(HMONITOR mon, int lx, int ly, int w, int h, uint8_t* out, int outStride, int dx, int dy) {
	DxgiSession& s = g_dxgi[mon];
	for (int attempt = 0; attempt < 2; attempt++) {
		if (!s.dup) {
			int32_t r = dxgiOpen(mon, s);
			if (r != GC_OK) return r;
			if (attempt > 0) s.recreated++;
		}
		DXGI_OUTDUPL_FRAME_INFO info;
		IDXGIResource* res = nullptr;
		// Only wait if we have nothing yet; otherwise reuse the last image when the
		// desktop has not changed (AcquireNextFrame only returns on change).
		HRESULT hr = s.dup->AcquireNextFrame(s.haveFrame ? 0 : 500, &info, &res);
		if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
			s.timeouts++;
			if (!s.haveFrame) {
				setErr("DXGI: no first frame within 500 ms");
				return GC_E_NO_FRAME;
			}
			break;
		}
		if (hr == DXGI_ERROR_ACCESS_LOST || hr == DXGI_ERROR_INVALID_CALL) {
			s.accessLost++;
			s.releaseDup();
			continue; // mode change, fullscreen switch, desktop switch: recreate once
		}
		if (FAILED(hr)) {
			setErr("AcquireNextFrame hr=0x%08lx", (unsigned long)hr);
			return GC_E_API;
		}
		ID3D11Texture2D* tex = nullptr;
		hr = res->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&tex);
		res->Release();
		if (SUCCEEDED(hr)) {
			D3D11_TEXTURE2D_DESC td;
			tex->GetDesc(&td);
			if (s.last) {
				D3D11_TEXTURE2D_DESC ld;
				s.last->GetDesc(&ld);
				if (td.Width != ld.Width || td.Height != ld.Height) safeRelease(s.last);
			}
			if (!s.last) s.last = makeCopyTarget(s.dev, td.Width, td.Height);
			if (s.last) s.ctx->CopyResource(s.last, tex);
			tex->Release();
			s.haveFrame = s.last != nullptr;
			s.framesAcquired++;
		}
		s.dup->ReleaseFrame();
		break;
	}
	if (!s.haveFrame) {
		setErr("DXGI: no frame (access lost twice?)");
		return GC_E_NO_FRAME;
	}
	return readbackRegion(s.dev, s.ctx, s.last, s.st, lx, ly, w, h, out, outStride, dx, dy);
}

// ---------------------------------------------------------------------------
// Windows.Graphics.Capture through the raw WinRT ABI.

struct GSizeInt32 {
	int32_t Width, Height;
};

// clang-format off
struct GIGraphicsCaptureItemInterop : public IUnknown {
	virtual HRESULT STDMETHODCALLTYPE CreateForWindow(HWND, REFIID, void**) = 0;
	virtual HRESULT STDMETHODCALLTYPE CreateForMonitor(HMONITOR, REFIID, void**) = 0;
};
struct GIDirect3DDxgiInterfaceAccess : public IUnknown {
	virtual HRESULT STDMETHODCALLTYPE GetInterface(REFIID, void**) = 0;
};
struct GIGraphicsCaptureItem : public IInspectable {
	virtual HRESULT STDMETHODCALLTYPE get_DisplayName(void** hstring) = 0;
	virtual HRESULT STDMETHODCALLTYPE get_Size(GSizeInt32*) = 0;
	virtual HRESULT STDMETHODCALLTYPE add_Closed(void*, int64_t*) = 0;
	virtual HRESULT STDMETHODCALLTYPE remove_Closed(int64_t) = 0;
};
struct GIDirect3D11CaptureFrame : public IInspectable {
	virtual HRESULT STDMETHODCALLTYPE get_Surface(IInspectable**) = 0;
	virtual HRESULT STDMETHODCALLTYPE get_SystemRelativeTime(int64_t*) = 0;
	virtual HRESULT STDMETHODCALLTYPE get_ContentSize(GSizeInt32*) = 0;
};
struct GIGraphicsCaptureSession : public IInspectable {
	virtual HRESULT STDMETHODCALLTYPE StartCapture() = 0;
};
struct GIGraphicsCaptureSession2 : public IInspectable {
	virtual HRESULT STDMETHODCALLTYPE get_IsCursorCaptureEnabled(uint8_t*) = 0;
	virtual HRESULT STDMETHODCALLTYPE put_IsCursorCaptureEnabled(uint8_t) = 0;
};
struct GIGraphicsCaptureSession3 : public IInspectable {
	virtual HRESULT STDMETHODCALLTYPE get_IsBorderRequired(uint8_t*) = 0;
	virtual HRESULT STDMETHODCALLTYPE put_IsBorderRequired(uint8_t) = 0;
};
struct GIDirect3D11CaptureFramePool : public IInspectable {
	virtual HRESULT STDMETHODCALLTYPE Recreate(IInspectable*, int32_t, int32_t, GSizeInt32) = 0;
	virtual HRESULT STDMETHODCALLTYPE TryGetNextFrame(GIDirect3D11CaptureFrame**) = 0;
	virtual HRESULT STDMETHODCALLTYPE add_FrameArrived(void*, int64_t*) = 0;
	virtual HRESULT STDMETHODCALLTYPE remove_FrameArrived(int64_t) = 0;
	virtual HRESULT STDMETHODCALLTYPE CreateCaptureSession(GIGraphicsCaptureItem*, GIGraphicsCaptureSession**) = 0;
	virtual HRESULT STDMETHODCALLTYPE get_DispatcherQueue(void**) = 0;
};
struct GIDirect3D11CaptureFramePoolStatics2 : public IInspectable {
	virtual HRESULT STDMETHODCALLTYPE CreateFreeThreaded(IInspectable* device, int32_t pixelFormat, int32_t buffers, GSizeInt32 size, GIDirect3D11CaptureFramePool** result) = 0;
};
struct GIGraphicsCaptureSessionStatics : public IInspectable {
	virtual HRESULT STDMETHODCALLTYPE IsSupported(uint8_t*) = 0;
};
struct GIGraphicsCaptureAccessStatics : public IInspectable {
	virtual HRESULT STDMETHODCALLTYPE RequestAccessAsync(int32_t kind, IInspectable** op) = 0;
};
struct GIAsyncInfo : public IInspectable {
	virtual HRESULT STDMETHODCALLTYPE get_Id(uint32_t*) = 0;
	virtual HRESULT STDMETHODCALLTYPE get_Status(int32_t*) = 0;
	virtual HRESULT STDMETHODCALLTYPE get_ErrorCode(HRESULT*) = 0;
	virtual HRESULT STDMETHODCALLTYPE Cancel() = 0;
	virtual HRESULT STDMETHODCALLTYPE Close() = 0;
};
// IAsyncOperation<AppCapabilityAccessStatus>: IID is parametric, never QI'd;
// RequestAccessAsync returns this interface directly.
struct GIAsyncOperationInt32 : public IInspectable {
	virtual HRESULT STDMETHODCALLTYPE put_Completed(void*) = 0;
	virtual HRESULT STDMETHODCALLTYPE get_Completed(void**) = 0;
	virtual HRESULT STDMETHODCALLTYPE GetResults(int32_t*) = 0;
};
struct GIClosable : public IInspectable {
	virtual HRESULT STDMETHODCALLTYPE Close() = 0;
};
struct GIDirect3DDevice : public IInspectable {
	virtual HRESULT STDMETHODCALLTYPE Trim() = 0;
};
// clang-format on

// Explicit IIDs (no __uuidof) so MSVC and mingw/zig agree.
[[maybe_unused]] static const IID IID_GIGraphicsCaptureItemInterop = {0x3628E81B, 0x3CAC, 0x4C60, {0xB7, 0xF4, 0x23, 0xCE, 0x0E, 0x0C, 0x33, 0x56}};
[[maybe_unused]] static const IID IID_GIDirect3DDxgiInterfaceAccess = {0xA9B3D012, 0x3DF2, 0x4EE3, {0xB8, 0xD1, 0x86, 0x95, 0xF4, 0x57, 0xD3, 0xC1}};
[[maybe_unused]] static const IID IID_GIGraphicsCaptureItem = {0x79C3F95B, 0x31F7, 0x4EC2, {0xA4, 0x64, 0x63, 0x2E, 0xF5, 0xD3, 0x07, 0x60}};
[[maybe_unused]] static const IID IID_GIDirect3D11CaptureFrame = {0xFA50C623, 0x38DA, 0x4B32, {0xAC, 0xF3, 0xFA, 0x97, 0x34, 0xAD, 0x80, 0x0E}};
[[maybe_unused]] static const IID IID_GIGraphicsCaptureSession = {0x814E42A9, 0xF70F, 0x4AD7, {0x93, 0x9B, 0xFD, 0xDC, 0xC6, 0xEB, 0x88, 0x0D}};
[[maybe_unused]] static const IID IID_GIGraphicsCaptureSession2 = {0x2C39AE40, 0x7D2E, 0x5044, {0x80, 0x4E, 0x8B, 0x67, 0x99, 0xD4, 0xCF, 0x9E}};
[[maybe_unused]] static const IID IID_GIGraphicsCaptureSession3 = {0xF2CDD966, 0x22AE, 0x5EA1, {0x95, 0x96, 0x3A, 0x28, 0x93, 0x44, 0xC3, 0xBE}};
[[maybe_unused]] static const IID IID_GIDirect3D11CaptureFramePool = {0x24EB6D22, 0x1975, 0x422E, {0x82, 0xE7, 0x78, 0x0D, 0xBD, 0x8D, 0xDF, 0x24}};
[[maybe_unused]] static const IID IID_GIDirect3D11CaptureFramePoolStatics2 = {0x589B103F, 0x6BBC, 0x5DF5, {0xA9, 0x91, 0x02, 0xE2, 0x8B, 0x3B, 0x66, 0xD5}};
[[maybe_unused]] static const IID IID_GIGraphicsCaptureSessionStatics = {0x2224A540, 0x5974, 0x49AA, {0xB2, 0x32, 0x08, 0x82, 0x53, 0x6F, 0x4C, 0xB5}};
[[maybe_unused]] static const IID IID_GIGraphicsCaptureAccessStatics = {0x743ED370, 0x06EC, 0x5040, {0xA5, 0x8A, 0x90, 0x1F, 0x0F, 0x75, 0x70, 0x95}};
[[maybe_unused]] static const IID IID_GIAsyncInfo = {0x00000036, 0x0000, 0x0000, {0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};
[[maybe_unused]] static const IID IID_GIClosable = {0x30D5A829, 0x7FA4, 0x4026, {0x83, 0xBB, 0xD7, 0x5B, 0xAE, 0x4E, 0xA9, 0x9E}};
[[maybe_unused]] static const IID IID_GIDirect3DDevice = {0xA37624AB, 0x8D5F, 0x4650, {0x9D, 0x3E, 0x9E, 0xAE, 0x3D, 0x9B, 0xC6, 0x70}};

typedef struct HSTRING__* GHSTRING;
typedef HRESULT(WINAPI* PFN_RoInitialize)(int);
typedef HRESULT(WINAPI* PFN_RoGetActivationFactory)(GHSTRING, REFIID, void**);
typedef HRESULT(WINAPI* PFN_WindowsCreateString)(LPCWSTR, UINT32, GHSTRING*);
typedef HRESULT(WINAPI* PFN_WindowsDeleteString)(GHSTRING);
typedef HRESULT(WINAPI* PFN_CreateDirect3D11DeviceFromDXGIDevice)(IDXGIDevice*, IInspectable**);

struct WinRt {
	bool loaded = false;
	PFN_RoInitialize roInit = nullptr;
	PFN_RoGetActivationFactory getFactory = nullptr;
	PFN_WindowsCreateString createStr = nullptr;
	PFN_WindowsDeleteString deleteStr = nullptr;
	PFN_CreateDirect3D11DeviceFromDXGIDevice createD3DDevice = nullptr;
} g_rt;

static bool loadWinRt() {
	if (g_rt.loaded) return g_rt.getFactory != nullptr;
	g_rt.loaded = true;
	HMODULE combase = LoadLibraryW(L"combase.dll");
	HMODULE d3d11 = LoadLibraryW(L"d3d11.dll");
	if (!combase || !d3d11) return false;
	g_rt.roInit = (PFN_RoInitialize)GetProcAddress(combase, "RoInitialize");
	g_rt.getFactory = (PFN_RoGetActivationFactory)GetProcAddress(combase, "RoGetActivationFactory");
	g_rt.createStr = (PFN_WindowsCreateString)GetProcAddress(combase, "WindowsCreateString");
	g_rt.deleteStr = (PFN_WindowsDeleteString)GetProcAddress(combase, "WindowsDeleteString");
	g_rt.createD3DDevice = (PFN_CreateDirect3D11DeviceFromDXGIDevice)GetProcAddress(d3d11, "CreateDirect3D11DeviceFromDXGIDevice");
	if (!g_rt.roInit || !g_rt.getFactory || !g_rt.createStr || !g_rt.deleteStr || !g_rt.createD3DDevice) {
		g_rt.getFactory = nullptr;
		return false;
	}
	// MTA; RPC_E_CHANGED_MODE (thread already STA) is fine for free-threaded pools.
	g_rt.roInit(1 /*RO_INIT_MULTITHREADED*/);
	return true;
}

static HRESULT activationFactory(const wchar_t* cls, REFIID iid, void** out) {
	GHSTRING s = nullptr;
	HRESULT hr = g_rt.createStr(cls, (UINT32)wcslen(cls), &s);
	if (FAILED(hr)) return hr;
	hr = g_rt.getFactory(s, iid, out);
	g_rt.deleteStr(s);
	return hr;
}

struct WgcSession {
	ID3D11Device* dev = nullptr;
	ID3D11DeviceContext* ctx = nullptr;
	GIDirect3DDevice* rtDevice = nullptr;
	GIGraphicsCaptureItem* item = nullptr;
	GIDirect3D11CaptureFramePool* pool = nullptr;
	GIGraphicsCaptureSession* session = nullptr;
	ID3D11Texture2D* last = nullptr;
	Staging st;
	GSizeInt32 size{};
	bool haveFrame = false;
	std::string borderNote;
	uint64_t framesReceived = 0, polls = 0, staleReuses = 0;
	void reset() {
		if (session) {
			GIClosable* c = nullptr;
			if (SUCCEEDED(session->QueryInterface(IID_GIClosable, (void**)&c))) {
				c->Close();
				c->Release();
			}
		}
		if (pool) {
			GIClosable* c = nullptr;
			if (SUCCEEDED(pool->QueryInterface(IID_GIClosable, (void**)&c))) {
				c->Close();
				c->Release();
			}
		}
		st.reset();
		safeRelease(last);
		safeRelease(session);
		safeRelease(pool);
		safeRelease(item);
		safeRelease(rtDevice);
		safeRelease(ctx);
		safeRelease(dev);
		haveFrame = false;
	}
};
static std::map<HMONITOR, WgcSession> g_wgc;

static int32_t wgcOpen(HMONITOR mon, WgcSession& s) {
	if (!loadWinRt()) {
		setErr("WinRT entry points unavailable (needs Windows 10 1903+)");
		return GC_E_UNSUPPORTED;
	}
	GIGraphicsCaptureSessionStatics* ss = nullptr;
	HRESULT hr = activationFactory(L"Windows.Graphics.Capture.GraphicsCaptureSession", IID_GIGraphicsCaptureSessionStatics, (void**)&ss);
	if (SUCCEEDED(hr)) {
		uint8_t sup = 0;
		ss->IsSupported(&sup);
		ss->Release();
		if (!sup) {
			setErr("GraphicsCaptureSession.IsSupported() == false");
			return GC_E_UNSUPPORTED;
		}
	}
	D3D_FEATURE_LEVEL fl;
	hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &s.dev, &fl, &s.ctx);
	if (FAILED(hr)) {
		setErr("D3D11CreateDevice hr=0x%08lx", (unsigned long)hr);
		return GC_E_API;
	}
	IDXGIDevice* dxgiDev = nullptr;
	s.dev->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgiDev);
	IInspectable* insp = nullptr;
	hr = g_rt.createD3DDevice(dxgiDev, &insp);
	safeRelease(dxgiDev);
	if (FAILED(hr)) {
		setErr("CreateDirect3D11DeviceFromDXGIDevice hr=0x%08lx", (unsigned long)hr);
		return GC_E_API;
	}
	hr = insp->QueryInterface(IID_GIDirect3DDevice, (void**)&s.rtDevice);
	insp->Release();
	if (FAILED(hr)) {
		setErr("QI IDirect3DDevice hr=0x%08lx", (unsigned long)hr);
		return GC_E_API;
	}
	GIGraphicsCaptureItemInterop* interop = nullptr;
	hr = activationFactory(L"Windows.Graphics.Capture.GraphicsCaptureItem", IID_GIGraphicsCaptureItemInterop, (void**)&interop);
	if (FAILED(hr)) {
		setErr("GraphicsCaptureItem interop factory hr=0x%08lx", (unsigned long)hr);
		return GC_E_API;
	}
	hr = interop->CreateForMonitor(mon, IID_GIGraphicsCaptureItem, (void**)&s.item);
	interop->Release();
	if (FAILED(hr)) {
		setErr("CreateForMonitor hr=0x%08lx", (unsigned long)hr);
		return GC_E_API;
	}
	s.item->get_Size(&s.size);
	GIDirect3D11CaptureFramePoolStatics2* ps = nullptr;
	hr = activationFactory(L"Windows.Graphics.Capture.Direct3D11CaptureFramePool", IID_GIDirect3D11CaptureFramePoolStatics2, (void**)&ps);
	if (FAILED(hr)) {
		setErr("FramePoolStatics2 hr=0x%08lx", (unsigned long)hr);
		return GC_E_API;
	}
	hr = ps->CreateFreeThreaded(s.rtDevice, 87 /*B8G8R8A8UIntNormalized*/, 2, s.size, &s.pool);
	ps->Release();
	if (FAILED(hr)) {
		setErr("CreateFreeThreaded hr=0x%08lx", (unsigned long)hr);
		return GC_E_API;
	}
	hr = s.pool->CreateCaptureSession(s.item, &s.session);
	if (FAILED(hr)) {
		setErr("CreateCaptureSession hr=0x%08lx", (unsigned long)hr);
		return GC_E_API;
	}
	GIGraphicsCaptureSession2* s2 = nullptr;
	if (SUCCEEDED(s.session->QueryInterface(IID_GIGraphicsCaptureSession2, (void**)&s2))) {
		s2->put_IsCursorCaptureEnabled(g_optCursor ? 1 : 0);
		s2->Release();
	}
	GIGraphicsCaptureSession3* s3 = nullptr;
	if (SUCCEEDED(s.session->QueryInterface(IID_GIGraphicsCaptureSession3, (void**)&s3))) {
		HRESULT bh = s3->put_IsBorderRequired(g_optBorder ? 1 : 0);
		uint8_t now = 1;
		s3->get_IsBorderRequired(&now);
		char b[160];
		snprintf(b, sizeof b, "put_IsBorderRequired(%d) hr=0x%08lx, reads back %d", g_optBorder ? 1 : 0, (unsigned long)bh, now);
		s.borderNote = b;
		s3->Release();
	} else {
		s.borderNote = "IGraphicsCaptureSession3 unavailable (pre-20348): border cannot be disabled";
	}
	hr = s.session->StartCapture();
	if (FAILED(hr)) {
		setErr("StartCapture hr=0x%08lx", (unsigned long)hr);
		return GC_E_API;
	}
	return GC_OK;
}

static int32_t captureWgc(HMONITOR mon, int lx, int ly, int w, int h, uint8_t* out, int outStride, int dx, int dy) {
	WgcSession& s = g_wgc[mon];
	if (!s.session) {
		int32_t r = wgcOpen(mon, s);
		if (r != GC_OK) {
			s.reset();
			return r;
		}
	}
	// Drain to the newest frame. WGC only produces frames when the content
	// changes, so "no new frame" with a previous one in hand is normal.
	DWORD start = GetTickCount();
	for (;;) {
		GIDirect3D11CaptureFrame* latest = nullptr;
		GIDirect3D11CaptureFrame* f = nullptr;
		while (SUCCEEDED(s.pool->TryGetNextFrame(&f)) && f) {
			if (latest) {
				GIClosable* c = nullptr;
				if (SUCCEEDED(latest->QueryInterface(IID_GIClosable, (void**)&c))) {
					c->Close();
					c->Release();
				}
				latest->Release();
			}
			latest = f;
			f = nullptr;
		}
		s.polls++;
		if (latest) {
			IInspectable* surf = nullptr;
			latest->get_Surface(&surf);
			GIDirect3DDxgiInterfaceAccess* access = nullptr;
			ID3D11Texture2D* tex = nullptr;
			if (surf && SUCCEEDED(surf->QueryInterface(IID_GIDirect3DDxgiInterfaceAccess, (void**)&access))) {
				access->GetInterface(__uuidof(ID3D11Texture2D), (void**)&tex);
				access->Release();
			}
			if (surf) surf->Release();
			if (tex) {
				D3D11_TEXTURE2D_DESC td;
				tex->GetDesc(&td);
				if (s.last) {
					D3D11_TEXTURE2D_DESC ld;
					s.last->GetDesc(&ld);
					if (ld.Width != td.Width || ld.Height != td.Height) safeRelease(s.last);
				}
				if (!s.last) s.last = makeCopyTarget(s.dev, td.Width, td.Height);
				if (s.last) s.ctx->CopyResource(s.last, tex);
				tex->Release();
				s.haveFrame = s.last != nullptr;
				s.framesReceived++;
			}
			GIClosable* c = nullptr;
			if (SUCCEEDED(latest->QueryInterface(IID_GIClosable, (void**)&c))) {
				c->Close();
				c->Release();
			}
			latest->Release();
			break;
		}
		if (s.haveFrame) {
			s.staleReuses++;
			break;
		}
		if (GetTickCount() - start > 1000) {
			setErr("WGC: no first frame within 1 s");
			return GC_E_NO_FRAME;
		}
		Sleep(2);
	}
	return readbackRegion(s.dev, s.ctx, s.last, s.st, lx, ly, w, h, out, outStride, dx, dy);
}

// ---------------------------------------------------------------------------
// C ABI

GC_EXPORT int32_t gc_abi_version() {
	return 1;
}

GC_EXPORT int32_t gc_last_error(char* buf, int32_t cap) {
	return copyOut(g_err, buf, cap);
}

GC_EXPORT int32_t gc_displays_json(char* buf, int32_t cap) {
	auto ms = monitors();
	std::string j = "{\"platform\":\"win32\",\"dpiMode\":\"" + jsonEscape(g_dpiMode) + "\",\"displays\":[";
	for (size_t i = 0; i < ms.size(); i++) {
		const auto& m = ms[i];
		char b[512];
		snprintf(b, sizeof b,
			"%s{\"id\":%llu,\"name\":\"%s\",\"bounds\":{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld},"
			"\"pixelScale\":1,\"uiScale\":%.4f,\"dpi\":%u,\"primary\":%s}",
			i ? "," : "", (unsigned long long)(uintptr_t)m.handle, jsonEscape(narrow(m.device)).c_str(),
			m.rect.left, m.rect.top, m.rect.right - m.rect.left, m.rect.bottom - m.rect.top,
			m.dpi / 96.0, m.dpi, m.primary ? "true" : "false");
		j += b;
	}
	j += "]}";
	return copyOut(j, buf, cap);
}

GC_EXPORT int32_t gc_set_option(int32_t key, int32_t value) {
	switch (key) {
	case OPT_CURSOR: g_optCursor = value != 0; return GC_OK;
	case OPT_WGC_BORDER: g_optBorder = value != 0; return GC_OK;
	case OPT_CAPTUREBLT: g_optCaptureBlt = value != 0; return GC_OK;
	default: setErr("unknown option %d", key); return GC_E_ARGS;
	}
}

GC_EXPORT void gc_reset() {
	g_gdi.reset();
	for (auto& kv : g_dxgi) kv.second.reset();
	g_dxgi.clear();
	for (auto& kv : g_wgc) kv.second.reset();
	g_wgc.clear();
}

// Ask for borderless WGC capture. Returns AppCapabilityAccessStatus
// (0 DeniedBySystem, 1 NotDeclaredByApp, 2 DeniedByUser, 3 UserPromptRequired,
// 4 Allowed) or a negative GC_E_* code; details in gc_last_error.
GC_EXPORT int32_t gc_wgc_request_borderless(int32_t timeoutMs) {
	if (!loadWinRt()) {
		setErr("WinRT unavailable");
		return GC_E_UNSUPPORTED;
	}
	GIGraphicsCaptureAccessStatics* st = nullptr;
	HRESULT hr = activationFactory(L"Windows.Graphics.Capture.GraphicsCaptureAccess", IID_GIGraphicsCaptureAccessStatics, (void**)&st);
	if (FAILED(hr)) {
		setErr("GraphicsCaptureAccess factory hr=0x%08lx (needs Windows 11 / 20348+)", (unsigned long)hr);
		return GC_E_UNSUPPORTED;
	}
	IInspectable* op = nullptr;
	hr = st->RequestAccessAsync(0 /*Borderless*/, &op);
	st->Release();
	if (FAILED(hr) || !op) {
		setErr("RequestAccessAsync(Borderless) hr=0x%08lx", (unsigned long)hr);
		return GC_E_API;
	}
	GIAsyncInfo* info = nullptr;
	op->QueryInterface(IID_GIAsyncInfo, (void**)&info);
	int32_t status = 0;
	DWORD start = GetTickCount();
	while (info && SUCCEEDED(info->get_Status(&status)) && status == 0 /*Started*/) {
		if ((int32_t)(GetTickCount() - start) > timeoutMs) break;
		Sleep(10);
	}
	int32_t result = GC_E_API;
	if (status == 1 /*Completed*/) {
		int32_t access = -1;
		hr = ((GIAsyncOperationInt32*)op)->GetResults(&access);
		if (SUCCEEDED(hr)) result = access;
		else setErr("GetResults hr=0x%08lx", (unsigned long)hr);
	} else if (status == 3 /*Error*/) {
		HRESULT ec = 0;
		info->get_ErrorCode(&ec);
		setErr("RequestAccessAsync failed hr=0x%08lx", (unsigned long)ec);
	} else {
		setErr("RequestAccessAsync status=%d (timeout or cancelled)", status);
	}
	if (info) info->Release();
	op->Release();
	return result;
}

GC_EXPORT int32_t gc_stats_json(char* buf, int32_t cap) {
	std::string j = "{\"dxgi\":[";
	bool first = true;
	for (auto& kv : g_dxgi) {
		char b[256];
		snprintf(b, sizeof b, "%s{\"monitor\":%llu,\"framesAcquired\":%llu,\"timeouts\":%llu,\"accessLost\":%llu,\"recreated\":%llu}",
			first ? "" : ",", (unsigned long long)(uintptr_t)kv.first, (unsigned long long)kv.second.framesAcquired,
			(unsigned long long)kv.second.timeouts, (unsigned long long)kv.second.accessLost, (unsigned long long)kv.second.recreated);
		j += b;
		first = false;
	}
	j += "],\"wgc\":[";
	first = true;
	for (auto& kv : g_wgc) {
		char b[512];
		snprintf(b, sizeof b, "%s{\"monitor\":%llu,\"framesReceived\":%llu,\"polls\":%llu,\"staleReuses\":%llu,\"border\":\"%s\"}",
			first ? "" : ",", (unsigned long long)(uintptr_t)kv.first, (unsigned long long)kv.second.framesReceived,
			(unsigned long long)kv.second.polls, (unsigned long long)kv.second.staleReuses, jsonEscape(kv.second.borderNote).c_str());
		j += b;
		first = false;
	}
	j += "]}";
	return copyOut(j, buf, cap);
}

// Capture one per-display piece of a region into out (RGBA, stride outStride).
// gx/gy: global physical origin; lx/ly: same origin relative to the monitor;
// w/h: source size in physical px; dx..dh: destination rect (dw==w, dh==h on Windows).
GC_EXPORT int32_t gc_capture_piece(int32_t backend, uint64_t displayId, double gx, double gy, double lx, double ly,
	double w, double h, int32_t dx, int32_t dy, int32_t dw, int32_t dh, uint8_t* out, int32_t outStride, uint64_t outLen) {
	ensureDpiAware();
	if (!out || dw <= 0 || dh <= 0 || dx < 0 || dy < 0 || outStride < (dx + dw) * 4 ||
		(uint64_t)outStride * (uint64_t)(dy + dh) > outLen) {
		setErr("bad destination: d=%d,%d %dx%d stride=%d len=%llu", dx, dy, dw, dh, outStride, (unsigned long long)outLen);
		return GC_E_ARGS;
	}
	if ((int)w != dw || (int)h != dh) {
		setErr("Windows backends capture 1:1 physical pixels; got src %gx%g dst %dx%d", w, h, dw, dh);
		return GC_E_ARGS;
	}
	HMONITOR mon = (HMONITOR)(uintptr_t)displayId;
	switch (backend) {
	case BK_GDI: return captureGdi((int)gx, (int)gy, dw, dh, out, outStride, dx, dy);
	case BK_DXGI: return captureDxgi(mon, (int)lx, (int)ly, dw, dh, out, outStride, dx, dy);
	case BK_WGC: return captureWgc(mon, (int)lx, (int)ly, dw, dh, out, outStride, dx, dy);
	default: setErr("unknown backend %d", backend); return GC_E_BACKEND;
	}
}
