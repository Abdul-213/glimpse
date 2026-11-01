// glimpse.dll: Glimpse's Windows native helper (ARCHITECTURE.md section 6).
//
// C ABI only. Every export is prefixed glim_ and returns an int32 status:
//   0            ok
//   -1 .. -99    Glimpse's own codes (below; mirrored in app/src/bun/native/status.ts)
//   anything else an HRESULT from the failing OS call
// Text comes back through (char* buf, int32 cap) -> full length, NUL-terminated and
// truncated to cap; call again with a bigger buffer if the result is >= cap.
// Pixel buffers are caller-owned (Bun allocates, native writes into them).
#pragma once
#include <cstdint>
#include <string>

#define GLIM_EXPORT extern "C" __declspec(dllexport)

// Bump together with GLIM_ABI_VERSION in app/src/bun/native/load.ts.
#define GLIM_ABI 6

enum : int32_t {
	GLIM_OK = 0,
	GLIM_E_ARGS = -1,
	GLIM_E_NO_DISPLAY = -2,
	GLIM_E_UNSUPPORTED = -3,
	GLIM_E_API = -4,
	GLIM_E_NO_FRAME = -5,
	GLIM_E_BACKEND = -6,
	GLIM_E_TIMEOUT = -7,
	GLIM_E_PERMISSION = -8,
	GLIM_E_NOT_A_WINDOW = -9,
};

// Last error text for the calling thread (glim_last_error reads it).
void glimSetError(const char* fmt, ...);
int32_t glimCopyOut(const std::string& s, char* buf, int32_t cap);
