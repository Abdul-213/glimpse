// Screen-reader announcements for Live changes (GLIM-92, live-popup.md §10).
//
// The Live popup is usually not focused (a game is), and Narrator reads WebView2's aria-live
// regions only for the focused window. So Bun also raises a UI Automation notification event
// on the popup's HWND:
//   UiaHostProviderFromHwnd(hwnd) -> UiaRaiseNotificationEvent(provider, NotificationKind_Other,
//     NotificationProcessing_MostRecent, text, L"glimpse.live")
// Whether Narrator speaks a notification from a non-foreground window is unverified (owner
// question 8); NVDA and JAWS handle UIA notifications differently. Both entry points are
// loaded at run time (UIAutomationCore.dll, OleAut32.dll), so nothing new is linked and a
// Windows without UiaRaiseNotificationEvent (before 10 1709) just reports unsupported.
#include <windows.h>
#include <objbase.h>

#include <string>

#include "glimpse.h"

namespace {

// UIA enums (UIAutomationCore.h), restated to avoid pulling in the COM headers.
constexpr int kNotificationKindOther = 4;
constexpr int kNotificationProcessingMostRecent = 3;
constexpr int kNotificationProcessingImportantMostRecent = 1;

using HostProviderFromHwnd = HRESULT(WINAPI*)(HWND, void**);
using RaiseNotification = HRESULT(WINAPI*)(void*, int, int, BSTR, BSTR);
using SysAlloc = BSTR(WINAPI*)(const OLECHAR*);
using SysFree = void(WINAPI*)(BSTR);

struct Uia {
  HostProviderFromHwnd host = nullptr;
  RaiseNotification raise = nullptr;
  SysAlloc alloc = nullptr;
  SysFree free = nullptr;
  bool loaded = false;
};

Uia& uia() {
  static Uia u;
  if (!u.loaded) {
    u.loaded = true;
    HMODULE core = LoadLibraryW(L"UIAutomationCore.dll");
    HMODULE ole = LoadLibraryW(L"OleAut32.dll");
    if (core) {
      u.host = reinterpret_cast<HostProviderFromHwnd>(GetProcAddress(core, "UiaHostProviderFromHwnd"));
      u.raise = reinterpret_cast<RaiseNotification>(GetProcAddress(core, "UiaRaiseNotificationEvent"));
    }
    if (ole) {
      u.alloc = reinterpret_cast<SysAlloc>(GetProcAddress(ole, "SysAllocString"));
      u.free = reinterpret_cast<SysFree>(GetProcAddress(ole, "SysFreeString"));
    }
  }
  return u;
}

std::wstring widen(const char* utf8) {
  int n = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
  if (n <= 0) return std::wstring();
  std::wstring w(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8, -1, w.data(), n);
  w.resize(static_cast<size_t>(n - 1));
  return w;
}

}  // namespace

// Announce `utf8` through UIA on `hwnd` (the Live popup). priority >= 2 = ImportantMostRecent.
GLIM_EXPORT int32_t glim_announce(void* hwnd, const char* utf8, int32_t priority) {
  if (!hwnd || !utf8) {
    glimSetError("null window or text");
    return GLIM_E_ARGS;
  }
  Uia& u = uia();
  if (!u.host || !u.raise || !u.alloc || !u.free) {
    glimSetError("UiaRaiseNotificationEvent unavailable");
    return GLIM_E_UNSUPPORTED;
  }
  std::wstring text = widen(utf8);
  if (text.empty()) return GLIM_OK;
  // UIA providers may be used from any apartment; make sure this thread has one.
  HRESULT co = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  void* provider = nullptr;
  HRESULT hr = u.host(static_cast<HWND>(hwnd), &provider);
  if (SUCCEEDED(hr) && provider) {
    BSTR display = u.alloc(text.c_str());
    BSTR activity = u.alloc(L"glimpse.live");
    hr = u.raise(provider, kNotificationKindOther,
                 priority >= 2 ? kNotificationProcessingImportantMostRecent : kNotificationProcessingMostRecent, display,
                 activity);
    u.free(display);
    u.free(activity);
    static_cast<IUnknown*>(provider)->Release();
  }
  if (SUCCEEDED(co)) CoUninitialize();
  if (FAILED(hr)) {
    glimSetError("UiaRaiseNotificationEvent failed: 0x%08lx", static_cast<unsigned long>(hr));
    return static_cast<int32_t>(hr);
  }
  return GLIM_OK;
}

// *activeOut = 1 when a screen reader says it is running (SPI_GETSCREENREADER).
GLIM_EXPORT int32_t glim_screen_reader_active(int32_t* activeOut) {
  if (!activeOut) return GLIM_E_ARGS;
  BOOL on = FALSE;
  if (!SystemParametersInfoW(SPI_GETSCREENREADER, 0, &on, 0)) {
    glimSetError("SPI_GETSCREENREADER failed: %lu", GetLastError());
    return static_cast<int32_t>(GetLastError());
  }
  *activeOut = on ? 1 : 0;
  return GLIM_OK;
}
