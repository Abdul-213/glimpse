// Window helpers for glimpse.dll that need a window procedure (GLIM-116).
//
// The Snip popup uses Electrobun's `titleBarStyle: "hiddenInset"`, which keeps the DWM frame
// (shadow, rounded corners, system backdrop) by creating WS_CAPTION | WS_THICKFRAME and
// removing the caption in WM_NCCALCSIZE (spikes/window-materials/FINDINGS.md §3). Side
// effect: the popup can be resized by dragging its edges. A window procedure runs on the
// window's own (Electrobun UI) thread and bun:ffi callbacks run on the Bun worker, so the
// hit-test fix lives here: glim_window_disable_resize subclasses the HWND with a native
// procedure that turns the sizing border hits (HTLEFT .. HTBOTTOMRIGHT) into HTCLIENT, so
// clicks there reach the webview and no resize cursor shows. SetWindowLongPtrW(GWLP_WNDPROC)
// may be called from another thread of the same process; the original procedure is kept
// in a window property and every other message goes to it.
//
// glim_window_test_create / _hit_test / _destroy exist for native-smoke.ts: a hidden
// WS_POPUP | WS_THICKFRAME window on the calling thread, so CI can check the hit-test change
// without Electrobun (SendMessageW on the same thread calls the procedure directly).
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <cstdint>

#include "glimpse.h"

namespace {

const wchar_t* kOrigProp = L"GlimpseOrigWndProc";
const wchar_t* kTestClass = L"GlimpseTestWindow";

LRESULT CALLBACK noResizeProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
	WNDPROC orig = (WNDPROC)GetPropW(hwnd, kOrigProp);
	if (!orig) return DefWindowProcW(hwnd, msg, wp, lp);
	if (msg == WM_NCHITTEST) {
		LRESULT hit = CallWindowProcW(orig, hwnd, msg, wp, lp);
		if (hit >= HTLEFT && hit <= HTBOTTOMRIGHT) return HTCLIENT;
		return hit;
	}
	if (msg == WM_NCDESTROY) {
		RemovePropW(hwnd, kOrigProp);
		SetWindowLongPtrW(hwnd, GWLP_WNDPROC, (LONG_PTR)orig);
		return CallWindowProcW(orig, hwnd, msg, wp, lp);
	}
	return CallWindowProcW(orig, hwnd, msg, wp, lp);
}

}  // namespace

// Make a window's sizing border behave like its client area (no edge resize). Idempotent.
GLIM_EXPORT int32_t glim_window_disable_resize(void* hwndPtr) {
	HWND hwnd = (HWND)hwndPtr;
	if (!hwnd || !IsWindow(hwnd)) {
		glimSetError("not a window");
		return GLIM_E_NOT_A_WINDOW;
	}
	if (GetPropW(hwnd, kOrigProp)) return GLIM_OK;
	LONG_PTR current = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
	if (!current) {
		glimSetError("GetWindowLongPtrW(GWLP_WNDPROC) failed: %lu", GetLastError());
		return (int32_t)HRESULT_FROM_WIN32(GetLastError());
	}
	// The property first, so a message that arrives right after the swap finds it.
	if (!SetPropW(hwnd, kOrigProp, (HANDLE)current)) {
		glimSetError("SetPropW failed: %lu", GetLastError());
		return (int32_t)HRESULT_FROM_WIN32(GetLastError());
	}
	SetLastError(0);
	if (!SetWindowLongPtrW(hwnd, GWLP_WNDPROC, (LONG_PTR)noResizeProc) && GetLastError() != 0) {
		DWORD err = GetLastError();
		RemovePropW(hwnd, kOrigProp);
		glimSetError("SetWindowLongPtrW(GWLP_WNDPROC) failed: %lu", err);
		return (int32_t)HRESULT_FROM_WIN32(err);
	}
	return GLIM_OK;
}

// Smoke tests: a hidden 320 x 120 resizable popup at (100, 100) on the calling thread.
GLIM_EXPORT int32_t glim_window_test_create(void** out) {
	if (!out) return GLIM_E_ARGS;
	HINSTANCE inst = GetModuleHandleW(nullptr);
	WNDCLASSEXW wc{};
	wc.cbSize = sizeof wc;
	wc.lpfnWndProc = DefWindowProcW;
	wc.hInstance = inst;
	wc.lpszClassName = kTestClass;
	RegisterClassExW(&wc);  // fails harmlessly when already registered
	HWND hwnd = CreateWindowExW(WS_EX_TOOLWINDOW, kTestClass, L"Glimpse test window", WS_POPUP | WS_THICKFRAME, 100,
	                            100, 320, 120, nullptr, nullptr, inst, nullptr);
	if (!hwnd) {
		glimSetError("CreateWindowExW failed: %lu", GetLastError());
		return (int32_t)HRESULT_FROM_WIN32(GetLastError());
	}
	*out = hwnd;
	return GLIM_OK;
}

// Smoke tests: WM_NCHITTEST at screen point (x, y) of a window on the calling thread.
GLIM_EXPORT int32_t glim_window_test_hit_test(void* hwndPtr, int32_t x, int32_t y) {
	HWND hwnd = (HWND)hwndPtr;
	if (!hwnd || !IsWindow(hwnd)) return -1;
	return (int32_t)SendMessageW(hwnd, WM_NCHITTEST, 0, MAKELPARAM((SHORT)x, (SHORT)y));
}

GLIM_EXPORT int32_t glim_window_test_destroy(void* hwndPtr) {
	HWND hwnd = (HWND)hwndPtr;
	if (!hwnd || !IsWindow(hwnd)) return GLIM_E_ARGS;
	DestroyWindow(hwnd);
	return GLIM_OK;
}
