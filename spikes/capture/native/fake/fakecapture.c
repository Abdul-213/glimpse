// Linux-only test double implementing the same C ABI as the real libraries.
// It lets test/ffi.test.ts exercise the actual bun:ffi binding (15-argument
// gc_capture_piece with mixed i32/u64/f64/ptr) and the composition of
// per-display pieces into one RGBA buffer, without a screen.
//
// Two fake displays in macOS-style global points:
//   id 1: 0,0 200x100 @2x     id 2: 200,0 100x100 @1x
// Each output pixel encodes (displayId*40, local source x in points, local y, 255).
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static char err[256] = "";

static int32_t copy_out(const char* s, char* buf, int32_t cap) {
	int32_t n = (int32_t)strlen(s);
	if (buf && cap > 0) {
		int32_t m = n < cap - 1 ? n : cap - 1;
		memcpy(buf, s, (size_t)m);
		buf[m] = 0;
	}
	return n;
}

int32_t gc_abi_version(void) { return 1; }
int32_t gc_last_error(char* buf, int32_t cap) { return copy_out(err, buf, cap); }
int32_t gc_displays_json(char* buf, int32_t cap) {
	return copy_out(
		"{\"platform\":\"fake\",\"displays\":["
		"{\"id\":1,\"bounds\":{\"x\":0,\"y\":0,\"width\":200,\"height\":100},\"pixelScale\":2,\"uiScale\":2,\"primary\":true},"
		"{\"id\":2,\"bounds\":{\"x\":200,\"y\":0,\"width\":100,\"height\":100},\"pixelScale\":1,\"uiScale\":1,\"primary\":false}]}",
		buf, cap);
}
int32_t gc_set_option(int32_t key, int32_t value) { (void)key; (void)value; return 0; }
void gc_reset(void) {}
int32_t gc_stats_json(char* buf, int32_t cap) { return copy_out("{\"fake\":true}", buf, cap); }

int32_t gc_capture_piece(int32_t backend, uint64_t display, double gx, double gy, double lx, double ly,
	double w, double h, int32_t dx, int32_t dy, int32_t dw, int32_t dh, uint8_t* out, int32_t stride, uint64_t len) {
	(void)gx; (void)gy;
	if (backend != 1 && backend != 2) { snprintf(err, sizeof err, "fake: unknown backend %d", backend); return -6; }
	if (display != 1 && display != 2) { snprintf(err, sizeof err, "fake: no display %llu", (unsigned long long)display); return -2; }
	if (!out || (uint64_t)stride * (uint64_t)(dy + dh) > len || stride < (dx + dw) * 4) {
		snprintf(err, sizeof err, "fake: bad destination");
		return -1;
	}
	for (int32_t y = 0; y < dh; y++) {
		for (int32_t x = 0; x < dw; x++) {
			uint8_t* p = out + (size_t)(dy + y) * (size_t)stride + (size_t)(dx + x) * 4;
			double sx = lx + (x + 0.5) * w / dw; // sample centre, in source points
			double sy = ly + (y + 0.5) * h / dh;
			p[0] = (uint8_t)(display * 40);
			p[1] = (uint8_t)sx;
			p[2] = (uint8_t)sy;
			p[3] = 255;
		}
	}
	return 0;
}

// macOS-only symbols, so the darwin symbol table also binds.
int32_t gc_mac_preflight(void) { return 1; }
int32_t gc_mac_request(void) { return 1; }
int32_t gc_mac_sck_probe(int32_t timeout) { (void)timeout; return -3801; }
// Windows-only symbol, so the win32 symbol table also binds.
int32_t gc_wgc_request_borderless(int32_t timeout) { (void)timeout; return 4; }
