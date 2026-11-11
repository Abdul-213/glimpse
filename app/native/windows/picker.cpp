// Region-picker helpers for glimpse.dll (GLIM-91, docs/design/specs/region-picker.md 7, 9.2, 9.3).
//
//   glim_list_windows   top-level windows front to back, for window-edge snapping. Runs
//                       EnumWindows here so its callback stays native (no JSCallback).
//   glim_focus_save     remembers the foreground window at hotkey time
//   glim_focus_restore  gives it the foreground back on cancel / Live confirm
//
// Rects are PHYSICAL virtual-desktop pixels (per-monitor-DPI-aware v2), from
// DWMWA_EXTENDED_FRAME_BOUNDS, which excludes the invisible resize border GetWindowRect
// includes. TypeScript maps them to Electrobun's logical layout per monitor.
// Loupe pixels need nothing here: they come from the capture service (GDI one-shots).
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <dwmapi.h>

#include <cstdint>
#include <cstring>
#include <map>
#include <string>

#include "glimpse.h"

// Mirrors GlimWindowInfo in app/src/bun/native/window-info.ts (104 bytes, 8-aligned).
struct GlimWindowInfo {
	double x, y, w, h;  // physical px here; global logical on macOS
	int32_t pid;
	int32_t z;          // 0 = frontmost
	char app_name[64];  // UTF-8, NUL-terminated; never the window title
};
static_assert(sizeof(GlimWindowInfo) == 104, "GlimWindowInfo layout is part of the ABI");

typedef DPI_AWARENESS_CONTEXT(WINAPI* PFN_SetThreadDpiAwarenessContext)(DPI_AWARENESS_CONTEXT);

static void pickerDpiAware() {
	static PFN_SetThreadDpiAwarenessContext setThread = [] {
		HMODULE user32 = GetModuleHandleW(L"user32.dll");
		return user32 ? (PFN_SetThreadDpiAwarenessContext)(void*)GetProcAddress(user32, "SetThreadDpiAwarenessContext")
		              : nullptr;
	}();
	if (setThread) setThread(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
}

// Copy UTF-16 into a fixed UTF-8 buffer, never splitting a code point.
static void copyUtf8(const std::wstring& w, char* out, size_t cap) {
	out[0] = 0;
	if (w.empty() || cap == 0) return;
	int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
	if (n <= 0) return;
	std::string s((size_t)n, '\0');
	WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
	size_t len = s.size() < cap - 1 ? s.size() : cap - 1;
	while (len > 0 && len < s.size() && ((unsigned char)s[len] & 0xC0) == 0x80) len--;  // continuation byte
	memcpy(out, s.data(), len);
	out[len] = 0;
}

// The exe's FileDescription ("Microsoft Edge"), else its base name without ".exe".
static std::wstring appNameForPid(DWORD pid) {
	HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
	if (!proc) return L"";
	wchar_t path[MAX_PATH * 2];
	DWORD size = (DWORD)(sizeof path / sizeof path[0]);
	BOOL ok = QueryFullProcessImageNameW(proc, 0, path, &size);
	CloseHandle(proc);
	if (!ok) return L"";
	std::wstring full(path, size);

	DWORD ignored = 0;
	DWORD infoSize = GetFileVersionInfoSizeW(full.c_str(), &ignored);
	if (infoSize > 0) {
		std::string block(infoSize, '\0');
		if (GetFileVersionInfoW(full.c_str(), 0, infoSize, &block[0])) {
			struct LangCode {
				WORD lang, codepage;
			};
			LangCode* langs = nullptr;
			UINT langBytes = 0;
			if (VerQueryValueW(&block[0], L"\\VarFileInfo\\Translation", (void**)&langs, &langBytes) && langs &&
				langBytes >= sizeof(LangCode)) {
				wchar_t key[64];
				swprintf(key, 64, L"\\StringFileInfo\\%04x%04x\\FileDescription", langs[0].lang, langs[0].codepage);
				wchar_t* desc = nullptr;
				UINT descLen = 0;
				if (VerQueryValueW(&block[0], key, (void**)&desc, &descLen) && desc && descLen > 1) {
					std::wstring d(desc);
					while (!d.empty() && (d.back() == L' ' || d.back() == L'\t')) d.pop_back();
					if (!d.empty()) return d;
				}
			}
		}
	}
	size_t slash = full.find_last_of(L"\\/");
	std::wstring base = slash == std::wstring::npos ? full : full.substr(slash + 1);
	if (base.size() > 4 && _wcsicmp(base.c_str() + base.size() - 4, L".exe") == 0) base.resize(base.size() - 4);
	return base;
}

struct ListState {
	GlimWindowInfo* out;
	int32_t cap;
	int32_t count;
	int32_t total;
	DWORD self;
	std::map<DWORD, std::string> names;
};

static bool skippedClass(HWND hwnd) {
	wchar_t cls[64];
	if (!GetClassNameW(hwnd, cls, 64)) return false;
	return wcscmp(cls, L"Progman") == 0 || wcscmp(cls, L"WorkerW") == 0 || wcscmp(cls, L"Shell_TrayWnd") == 0 ||
	       wcscmp(cls, L"Shell_SecondaryTrayWnd") == 0;
}

static BOOL CALLBACK listProc(HWND hwnd, LPARAM lp) {
	auto* st = (ListState*)lp;
	if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return TRUE;
	DWORD pid = 0;
	GetWindowThreadProcessId(hwnd, &pid);
	if (pid == st->self) return TRUE;
	DWORD cloaked = 0;
	if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof cloaked)) && cloaked != 0) return TRUE;
	if (skippedClass(hwnd)) return TRUE;
	RECT r{};
	if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &r, sizeof r)) && !GetWindowRect(hwnd, &r)) {
		return TRUE;
	}
	if (r.right - r.left <= 0 || r.bottom - r.top <= 0) return TRUE;

	int32_t z = st->total++;
	if (st->count >= st->cap) return TRUE;  // keep counting so the caller can size up
	GlimWindowInfo& w = st->out[st->count++];
	w.x = r.left;
	w.y = r.top;
	w.w = r.right - r.left;
	w.h = r.bottom - r.top;
	w.pid = (int32_t)pid;
	w.z = z;
	auto it = st->names.find(pid);
	if (it == st->names.end()) {
		char buf[64];
		copyUtf8(appNameForPid(pid), buf, sizeof buf);
		it = st->names.emplace(pid, std::string(buf)).first;
	}
	memset(w.app_name, 0, sizeof w.app_name);
	memcpy(w.app_name, it->second.c_str(), it->second.size() < 63 ? it->second.size() : 63);
	return TRUE;
}

// Fill out[0..cap) with visible top-level windows of other processes, front to back.
// *countOut = how many were written; *totalOut (optional) = how many matched, which
// may exceed cap (call again with a bigger buffer).
GLIM_EXPORT int32_t glim_list_windows(GlimWindowInfo* out, int32_t cap, int32_t* countOut, int32_t* totalOut) {
	if (!countOut || cap < 0 || (cap > 0 && !out)) {
		glimSetError("bad window list buffer");
		return GLIM_E_ARGS;
	}
	pickerDpiAware();
	ListState st{out, cap, 0, 0, GetCurrentProcessId(), {}};
	if (!EnumWindows(listProc, (LPARAM)&st)) {
		DWORD e = GetLastError();
		if (e != 0) {
			glimSetError("EnumWindows failed (%lu)", e);
			return HRESULT_FROM_WIN32(e);
		}
	}
	*countOut = st.count;
	if (totalOut) *totalOut = st.total;
	return GLIM_OK;
}

// ---------------------------------------------------------------------------
// Focus (spec section 7)

static HWND g_savedForeground = nullptr;

// Remember the foreground window. Call at hotkey time, before any overlay shows.
// *hwndOut (optional) gets its value, for logs.
GLIM_EXPORT int32_t glim_focus_save(uint64_t* hwndOut) {
	g_savedForeground = GetForegroundWindow();
	if (hwndOut) *hwndOut = (uint64_t)(uintptr_t)g_savedForeground;
	return GLIM_OK;
}

// Give the saved window the foreground again. *restoredOut = 1 if it was asked to,
// 0 if there was nothing to restore (never saved, or the window is gone). The process
// that received the last input (the Esc in our overlay) may set the foreground, so
// SetForegroundWindow is allowed here; a refusal comes back as GLIM_E_API.
GLIM_EXPORT int32_t glim_focus_restore(int32_t* restoredOut) {
	if (restoredOut) *restoredOut = 0;
	HWND target = g_savedForeground;
	g_savedForeground = nullptr;
	if (!target || !IsWindow(target)) return GLIM_OK;
	if (IsIconic(target)) return GLIM_OK;  // don't un-minimise something the user minimised
	if (!SetForegroundWindow(target)) {
		glimSetError("SetForegroundWindow refused");
		return GLIM_E_API;
	}
	if (restoredOut) *restoredOut = 1;
	return GLIM_OK;
}
