// Shared exports of glimpse.dll: ABI version and last-error text.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <cstdarg>
#include <cstdio>
#include <cstring>

#include "glimpse.h"

static thread_local std::string t_error;

void glimSetError(const char* fmt, ...) {
	char buf[1024];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(buf, sizeof buf, fmt, ap);
	va_end(ap);
	t_error = buf;
}

int32_t glimCopyOut(const std::string& s, char* buf, int32_t cap) {
	if (buf && cap > 0) {
		size_t n = s.size() < (size_t)(cap - 1) ? s.size() : (size_t)(cap - 1);
		memcpy(buf, s.data(), n);
		buf[n] = 0;
	}
	return (int32_t)s.size();
}

GLIM_EXPORT int32_t glim_abi_version() {
	return GLIM_ABI;
}

GLIM_EXPORT int32_t glim_last_error(char* buf, int32_t cap) {
	return glimCopyOut(t_error, buf, cap);
}
