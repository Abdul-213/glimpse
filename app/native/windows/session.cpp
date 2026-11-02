// Screen lock / unlock and sleep / wake notifications for glimpse.dll (GLIM-119).
// Electrobun 2.0.6-beta.2 reports none of them; Live pauses on them (live-popup.md L17) and
// the translation cache is wiped on lock and sleep (GLIM-20).
//
//   lock / unlock  WTSRegisterSessionNotification -> WM_WTSSESSION_CHANGE
//                  (WTS_SESSION_LOCK / WTS_SESSION_UNLOCK)
//   sleep / wake   WM_POWERBROADCAST (PBT_APMSUSPEND / PBT_APMRESUMEAUTOMATIC,
//                  PBT_APMRESUMESUSPEND), plus RegisterSuspendResumeNotification so Modern
//                  Standby machines deliver them to this window too
//
// Power broadcasts only reach top-level windows, so this is a hidden (never shown)
// WS_POPUP tool window, not a message-only one. It lives on its own helper thread with its
// own message loop, like the Live frame's UI thread (frame.cpp), so the Bun worker never
// pumps messages. The callback is a JSCallback created with { threadsafe: true }: calling
// it from this thread queues the event onto the Bun worker.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <wtsapi32.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <mutex>

#include "glimpse.h"

namespace {

// kind: 1 lock, 2 unlock, 3 sleep, 4 wake. source: which message (diagnostics).
typedef void (*SessionCallback)(int32_t kind, int32_t source);

enum : int32_t { kLock = 1, kUnlock = 2, kSleep = 3, kWake = 4 };

typedef HANDLE(WINAPI* PFN_RegisterSuspendResumeNotification)(HANDLE, DWORD);
typedef BOOL(WINAPI* PFN_UnregisterSuspendResumeNotification)(HANDLE);

std::mutex g_lock;  // start / stop
std::atomic<SessionCallback> g_cb{nullptr};
HANDLE g_thread = nullptr;
HWND g_hwnd = nullptr;
bool g_wts = false;
HANDLE g_suspendResume = nullptr;
DWORD g_startError = 0;

const wchar_t* kClass = L"GlimpseSessionWatcher";

void emit(int32_t kind, int32_t source) {
	SessionCallback cb = g_cb.load();
	if (cb) cb(kind, source);
}

LRESULT CALLBACK sessionProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
	switch (msg) {
		case WM_WTSSESSION_CHANGE:
			if (wp == (WPARAM)WTS_SESSION_LOCK) emit(kLock, 1);
			else if (wp == (WPARAM)WTS_SESSION_UNLOCK) emit(kUnlock, 2);
			return 0;
		case WM_POWERBROADCAST:
			if (wp == (WPARAM)PBT_APMSUSPEND) emit(kSleep, 3);
			else if (wp == (WPARAM)PBT_APMRESUMEAUTOMATIC) emit(kWake, 4);
			else if (wp == (WPARAM)PBT_APMRESUMESUSPEND) emit(kWake, 5);
			return TRUE;
		case WM_CLOSE:
			DestroyWindow(hwnd);
			return 0;
		case WM_DESTROY:
			PostQuitMessage(0);
			return 0;
		default:
			return DefWindowProcW(hwnd, msg, wp, lp);
	}
}

DWORD WINAPI sessionThread(LPVOID ready) {
	HINSTANCE inst = GetModuleHandleW(nullptr);
	WNDCLASSEXW wc{};
	wc.cbSize = sizeof wc;
	wc.lpfnWndProc = sessionProc;
	wc.hInstance = inst;
	wc.lpszClassName = kClass;
	RegisterClassExW(&wc);
	// Top-level (broadcasts skip message-only windows), never shown, no taskbar button.
	HWND hwnd = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, kClass, L"Glimpse session watcher", WS_POPUP, 0, 0,
	                            0, 0, nullptr, nullptr, inst, nullptr);
	if (!hwnd) {
		g_startError = GetLastError();
		SetEvent((HANDLE)ready);
		return 1;
	}
	g_wts = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) != FALSE;
	if (!g_wts) g_startError = GetLastError();
	HMODULE user32 = GetModuleHandleW(L"user32.dll");
	auto reg = user32 ? (PFN_RegisterSuspendResumeNotification)(void*)GetProcAddress(
	                        user32, "RegisterSuspendResumeNotification")
	                  : nullptr;
	// DEVICE_NOTIFY_WINDOW_HANDLE = 0: WM_POWERBROADCAST to this window (Windows 8+).
	if (reg) g_suspendResume = reg(hwnd, 0);
	g_hwnd = hwnd;
	SetEvent((HANDLE)ready);
	MSG m;
	while (GetMessageW(&m, nullptr, 0, 0) > 0) {
		TranslateMessage(&m);
		DispatchMessageW(&m);
	}
	return 0;
}

}  // namespace

// Start the watcher thread; `cb` gets (kind, source) for every event. Calling it again
// replaces the callback. Returns GLIM_OK even if WTS registration failed (sleep / wake
// still work); glim_session_info says which parts are live.
GLIM_EXPORT int32_t glim_session_start(SessionCallback cb) {
	if (!cb) {
		glimSetError("null session callback");
		return GLIM_E_ARGS;
	}
	std::lock_guard<std::mutex> lock(g_lock);
	g_cb.store(cb);
	if (g_hwnd) return GLIM_OK;
	HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
	if (!ready) {
		glimSetError("CreateEventW failed: %lu", GetLastError());
		return GLIM_E_API;
	}
	g_startError = 0;
	g_thread = CreateThread(nullptr, 0, sessionThread, ready, 0, nullptr);
	if (!g_thread) {
		CloseHandle(ready);
		glimSetError("CreateThread failed: %lu", GetLastError());
		return GLIM_E_API;
	}
	DWORD w = WaitForSingleObject(ready, 5000);
	CloseHandle(ready);
	if (w != WAIT_OBJECT_0 || !g_hwnd) {
		glimSetError("session watcher did not start (error %lu)", g_startError);
		CloseHandle(g_thread);
		g_thread = nullptr;
		return g_startError ? (int32_t)HRESULT_FROM_WIN32(g_startError) : GLIM_E_TIMEOUT;
	}
	return GLIM_OK;
}

// Stop the watcher and drop the callback (call before closing the JSCallback).
GLIM_EXPORT int32_t glim_session_stop() {
	std::lock_guard<std::mutex> lock(g_lock);
	g_cb.store(nullptr);
	if (!g_hwnd) return GLIM_OK;
	HWND hwnd = g_hwnd;
	g_hwnd = nullptr;
	if (g_wts) WTSUnRegisterSessionNotification(hwnd);
	g_wts = false;
	if (g_suspendResume) {
		HMODULE user32 = GetModuleHandleW(L"user32.dll");
		auto unreg = user32 ? (PFN_UnregisterSuspendResumeNotification)(void*)GetProcAddress(
		                          user32, "UnregisterSuspendResumeNotification")
		                    : nullptr;
		if (unreg) unreg(g_suspendResume);
		g_suspendResume = nullptr;
	}
	PostMessageW(hwnd, WM_CLOSE, 0, 0);
	if (g_thread) {
		WaitForSingleObject(g_thread, 2000);
		CloseHandle(g_thread);
		g_thread = nullptr;
	}
	return GLIM_OK;
}

// Smoke tests: post the real OS message for `kind` to the watcher window, so the mapping in
// the window procedure and the callback path run as they would for a real lock or sleep.
GLIM_EXPORT int32_t glim_session_simulate(int32_t kind) {
	HWND hwnd = g_hwnd;
	if (!hwnd) {
		glimSetError("session watcher is not running");
		return GLIM_E_ARGS;
	}
	BOOL ok = FALSE;
	switch (kind) {
		case kLock:
			ok = PostMessageW(hwnd, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK, 0);
			break;
		case kUnlock:
			ok = PostMessageW(hwnd, WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK, 0);
			break;
		case kSleep:
			ok = PostMessageW(hwnd, WM_POWERBROADCAST, PBT_APMSUSPEND, 0);
			break;
		case kWake:
			ok = PostMessageW(hwnd, WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC, 0);
			break;
		default:
			glimSetError("bad session kind %d", kind);
			return GLIM_E_ARGS;
	}
	if (!ok) {
		glimSetError("PostMessageW failed: %lu", GetLastError());
		return (int32_t)HRESULT_FROM_WIN32(GetLastError());
	}
	return GLIM_OK;
}

// Windows needs no pump: the watcher thread runs its own message loop.
GLIM_EXPORT int32_t glim_session_pump(int32_t ms) {
	if (ms > 0) Sleep((DWORD)ms);
	return GLIM_OK;
}

// {"running":0|1,"wts":0|1,"suspendResume":0|1,"error":N}
GLIM_EXPORT int32_t glim_session_info(char* buf, int32_t cap) {
	char out[128];
	snprintf(out, sizeof out, "{\"running\":%d,\"wts\":%d,\"suspendResume\":%d,\"error\":%lu}", g_hwnd ? 1 : 0,
	         g_wts ? 1 : 0, g_suspendResume ? 1 : 0, (unsigned long)g_startError);
	return glimCopyOut(out, buf, cap);
}
