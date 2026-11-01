// Shared exports of libglimpse.dylib: ABI version and last-error text.
#import <Foundation/Foundation.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "glimpse.h"

static _Thread_local char t_error[1024];

void glim_set_error(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(t_error, sizeof t_error, fmt, ap);
  va_end(ap);
}

int32_t glim_copy_out(const char *s, char *buf, int32_t cap) {
  size_t len = s ? strlen(s) : 0;
  if (buf && cap > 0) {
    size_t n = len < (size_t)(cap - 1) ? len : (size_t)(cap - 1);
    if (n) memcpy(buf, s, n);
    buf[n] = 0;
  }
  return (int32_t)len;
}

GLIM_EXPORT int32_t glim_abi_version(void) { return GLIM_ABI; }

GLIM_EXPORT int32_t glim_last_error(char *buf, int32_t cap) { return glim_copy_out(t_error, buf, cap); }
