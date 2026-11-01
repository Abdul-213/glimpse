// GLIM-15 spike: macOS region capture behind a tiny C ABI, loaded by Bun via
// bun:ffi (dlopen). Same ABI shape as native/windows/glimcapture.cpp.
//
//   1  ScreenCaptureKit SCScreenshotManager.captureSampleBuffer (macOS 14+), one shot per call
//   2  ScreenCaptureKit SCStream (macOS 12.3+), persistent per display, latest frame reused
//
// The deprecated CGWindowListCreateImage path is *not* reimplemented here: it is
// exactly what Electrobun's built-in Screen.captureRegion() does, and the app
// benchmarks that directly as the "electrobun" backend.
//
// Pixels land in the caller's (Bun-owned) buffer: the CVPixelBuffer (BGRA,
// IOSurface-backed) is permuted to RGBA by vImage straight into the
// destination sub-rect. One copy, no IPC.
//
// SCK APIs are async; each C entry point blocks on a semaphore with a timeout,
// so a missing callback can never hang Bun forever.
//
// Build: native/macos/build.sh  (swiftc, Xcode command line tools)

import Accelerate
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

// MARK: - errors / helpers

private var lastError = ""
private func setErr(_ s: String) { lastError = s }

private let GC_OK: Int32 = 0
private let GC_E_ARGS: Int32 = -1
private let GC_E_NO_DISPLAY: Int32 = -2
private let GC_E_UNSUPPORTED: Int32 = -3
private let GC_E_API: Int32 = -4
private let GC_E_NO_FRAME: Int32 = -5
private let GC_E_BACKEND: Int32 = -6
private let GC_E_TIMEOUT: Int32 = -7

private let BK_SCK_SHOT: Int32 = 1
private let BK_SCK_STREAM: Int32 = 2

private let OPT_CURSOR: Int32 = 1
private let OPT_STREAM_FPS: Int32 = 3

private var optCursor = false
private var optStreamFps: Int32 = 4

private func copyOut(_ s: String, _ buf: UnsafeMutablePointer<CChar>?, _ cap: Int32) -> Int32 {
	let bytes = Array(s.utf8)
	if let buf = buf, cap > 0 {
		let n = min(bytes.count, Int(cap) - 1)
		if n > 0 {
			bytes.withUnsafeBufferPointer { p in
				buf.withMemoryRebound(to: UInt8.self, capacity: n) { d in d.update(from: p.baseAddress!, count: n) }
			}
		}
		buf[n] = 0
	}
	return Int32(bytes.count)
}

/// Run an async-callback API synchronously with a timeout.
private func blocking<T>(_ timeout: Double, _ body: (@escaping (T?, Error?) -> Void) -> Void) -> (T?, Error?, Bool) {
	let sem = DispatchSemaphore(value: 0)
	let lock = NSLock()
	var value: T?
	var error: Error?
	body { v, e in
		lock.lock()
		value = v
		error = e
		lock.unlock()
		sem.signal()
	}
	if sem.wait(timeout: .now() + timeout) == .timedOut { return (nil, nil, true) }
	lock.lock()
	defer { lock.unlock() }
	return (value, error, false)
}

private func describe(_ e: Error) -> (Int32, String) {
	let ns = e as NSError
	return (Int32(truncatingIfNeeded: ns.code), "\(ns.domain) \(ns.code): \(ns.localizedDescription)")
}

/// Copy a BGRA CVPixelBuffer into an RGBA sub-rect of `out`, alpha forced to 255.
private func blit(_ pb: CVPixelBuffer, _ out: UnsafeMutablePointer<UInt8>, _ outStride: Int, _ dx: Int, _ dy: Int, _ dw: Int, _ dh: Int) -> Int32 {
	guard CVPixelBufferGetPixelFormatType(pb) == kCVPixelFormatType_32BGRA else {
		setErr("unexpected pixel format \(CVPixelBufferGetPixelFormatType(pb))")
		return GC_E_UNSUPPORTED
	}
	CVPixelBufferLockBaseAddress(pb, .readOnly)
	defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
	guard let base = CVPixelBufferGetBaseAddress(pb) else {
		setErr("CVPixelBuffer has no base address")
		return GC_E_API
	}
	let w = min(dw, CVPixelBufferGetWidth(pb))
	let h = min(dh, CVPixelBufferGetHeight(pb))
	if w != dw || h != dh {
		// Should not happen (we ask SCK for exactly dw x dh). Fill what we have.
		setErr("frame is \(CVPixelBufferGetWidth(pb))x\(CVPixelBufferGetHeight(pb)), wanted \(dw)x\(dh)")
	}
	var src = vImage_Buffer(data: base, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: CVPixelBufferGetBytesPerRow(pb))
	var dst = vImage_Buffer(data: out + dy * outStride + dx * 4, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: outStride)
	let map: [UInt8] = [2, 1, 0, 3] // BGRA -> RGBA
	var err = vImagePermuteChannels_ARGB8888(&src, &dst, map, vImage_Flags(kvImageNoFlags))
	if err == kvImageNoError {
		// Mask bit 0x1 is the 4th byte of each pixel = alpha in RGBA order.
		err = vImageOverwriteChannelsWithScalar_ARGB8888(255, &dst, &dst, 0x1, vImage_Flags(kvImageNoFlags))
	}
	if err != kvImageNoError {
		setErr("vImage error \(err)")
		return GC_E_API
	}
	return GC_OK
}

// MARK: - displays

@_cdecl("gc_abi_version")
public func gc_abi_version() -> Int32 { 1 }

@_cdecl("gc_last_error")
public func gc_last_error(_ buf: UnsafeMutablePointer<CChar>?, _ cap: Int32) -> Int32 { copyOut(lastError, buf, cap) }

@_cdecl("gc_displays_json")
public func gc_displays_json(_ buf: UnsafeMutablePointer<CChar>?, _ cap: Int32) -> Int32 {
	var count: UInt32 = 0
	CGGetActiveDisplayList(0, nil, &count)
	var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
	CGGetActiveDisplayList(count, &ids, &count)
	var items: [String] = []
	for id in ids.prefix(Int(count)) {
		let b = CGDisplayBounds(id) // global points, top-left origin of the main display
		var scale = 1.0
		var pw = Int(b.width), ph = Int(b.height)
		if let mode = CGDisplayCopyDisplayMode(id) {
			pw = mode.pixelWidth
			ph = mode.pixelHeight
			if mode.width > 0 { scale = Double(mode.pixelWidth) / Double(mode.width) }
		}
		items.append(
			"{\"id\":\(id),\"bounds\":{\"x\":\(b.origin.x),\"y\":\(b.origin.y),\"width\":\(b.width),\"height\":\(b.height)},"
				+ "\"pixelScale\":\(scale),\"uiScale\":\(scale),\"pixelWidth\":\(pw),\"pixelHeight\":\(ph),"
				+ "\"primary\":\(CGDisplayIsMain(id) != 0),\"mirrored\":\(CGDisplayIsInMirrorSet(id) != 0)}")
	}
	let v = ProcessInfo.processInfo.operatingSystemVersion
	let json = "{\"platform\":\"darwin\",\"os\":\"\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)\",\"displays\":[\(items.joined(separator: ","))]}"
	return copyOut(json, buf, cap)
}

// MARK: - permission

@_cdecl("gc_mac_preflight")
public func gc_mac_preflight() -> Int32 { CGPreflightScreenCaptureAccess() ? 1 : 0 }

@_cdecl("gc_mac_request")
public func gc_mac_request() -> Int32 { CGRequestScreenCaptureAccess() ? 1 : 0 }

// MARK: - ScreenCaptureKit shared state

@available(macOS 12.3, *)
private enum SCK {
	static var content: SCShareableContent?
	static var filters: [CGDirectDisplayID: SCContentFilter] = [:]

	static func refresh(timeout: Double = 3) -> Int32 {
		let (c, e, timedOut) = blocking(timeout) { (done: @escaping (SCShareableContent?, Error?) -> Void) in
			SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { c, e in done(c, e) }
		}
		if timedOut {
			setErr("SCShareableContent timed out after \(timeout)s")
			return GC_E_TIMEOUT
		}
		if let e = e {
			let (code, msg) = describe(e)
			setErr("SCShareableContent: \(msg)")
			return code == 0 ? GC_E_API : code
		}
		content = c
		filters = [:]
		return GC_OK
	}

	static func filter(_ id: CGDirectDisplayID) -> SCContentFilter? {
		if let f = filters[id] { return f }
		if content == nil || !(content!.displays.contains { $0.displayID == id }) {
			if refresh() != GC_OK { return nil }
		}
		guard let d = content?.displays.first(where: { $0.displayID == id }) else {
			setErr("display \(id) not in SCShareableContent")
			return nil
		}
		// GLIM-16 will pass Glimpse's own windows here; this spike excludes nothing.
		let f = SCContentFilter(display: d, excludingWindows: [])
		filters[id] = f
		return f
	}

	static func display(_ id: CGDirectDisplayID) -> SCDisplay? {
		_ = filter(id)
		return content?.displays.first(where: { $0.displayID == id })
	}

	static func config(_ lx: Double, _ ly: Double, _ w: Double, _ h: Double, _ dw: Int, _ dh: Int) -> SCStreamConfiguration {
		let cfg = SCStreamConfiguration()
		cfg.sourceRect = CGRect(x: lx, y: ly, width: w, height: h) // display-local points
		cfg.width = dw // output pixels: points * scale chosen by the caller
		cfg.height = dh
		cfg.pixelFormat = kCVPixelFormatType_32BGRA
		cfg.colorSpaceName = CGColorSpace.sRGB
		cfg.showsCursor = optCursor
		cfg.scalesToFit = true
		if #available(macOS 14.0, *) { cfg.captureResolution = .best }
		return cfg
	}
}

/// 0 = ScreenCaptureKit usable; otherwise the NSError code (-3801 = user declined) or GC_E_*.
@_cdecl("gc_mac_sck_probe")
public func gc_mac_sck_probe(_ timeoutMs: Int32) -> Int32 {
	guard #available(macOS 12.3, *) else {
		setErr("ScreenCaptureKit needs macOS 12.3+")
		return GC_E_UNSUPPORTED
	}
	return SCK.refresh(timeout: Double(timeoutMs) / 1000)
}

// MARK: - SCStream sessions

@available(macOS 12.3, *)
private final class StreamSession: NSObject, SCStreamOutput, SCStreamDelegate {
	let displayID: CGDirectDisplayID
	var scStream: SCStream?
	let queue = DispatchQueue(label: "glimpse.capture.stream")
	let lock = NSLock()
	var latest: CVPixelBuffer?
	var complete = 0, idle = 0, other = 0
	var stopError: String?
	var key = ""

	init(displayID: CGDirectDisplayID) { self.displayID = displayID }

	func start(filter: SCContentFilter, cfg: SCStreamConfiguration, key: String) -> Int32 {
		stop()
		cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, optStreamFps)))
		cfg.queueDepth = 3
		let s = SCStream(filter: filter, configuration: cfg, delegate: self)
		do {
			try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
		} catch {
			setErr("addStreamOutput: \(describe(error).1)")
			return GC_E_API
		}
		let (_, e, timedOut) = blocking(3) { (done: @escaping (Bool?, Error?) -> Void) in
			s.startCapture { err in done(err == nil, err) }
		}
		if timedOut {
			setErr("SCStream.startCapture timed out")
			return GC_E_TIMEOUT
		}
		if let e = e {
			let (code, msg) = describe(e)
			setErr("SCStream.startCapture: \(msg)")
			return code == 0 ? GC_E_API : code
		}
		scStream = s
		self.key = key
		return GC_OK
	}

	func stop() {
		if let s = scStream {
			_ = blocking(2) { (done: @escaping (Bool?, Error?) -> Void) in s.stopCapture { e in done(true, e) } }
		}
		scStream = nil
		lock.lock()
		latest = nil
		lock.unlock()
	}

	func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
		guard type == .screen else { return }
		guard let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
			let raw = atts.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw)
		else { return }
		lock.lock()
		defer { lock.unlock() }
		if status == .complete, let pb = CMSampleBufferGetImageBuffer(sb) {
			latest = pb // keep only one buffer so the stream's pool never starves
			complete += 1
		} else if status == .idle {
			idle += 1 // screen unchanged: SCK sends no pixels
		} else {
			other += 1
		}
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		lock.lock()
		stopError = describe(error).1
		latest = nil
		lock.unlock()
		self.scStream = nil
	}
}

private var streams: [CGDirectDisplayID: AnyObject] = [:]

// MARK: - capture

@_cdecl("gc_set_option")
public func gc_set_option(_ key: Int32, _ value: Int32) -> Int32 {
	switch key {
	case OPT_CURSOR: optCursor = value != 0
	case OPT_STREAM_FPS: optStreamFps = max(1, value)
	default:
		setErr("unknown option \(key)")
		return GC_E_ARGS
	}
	return GC_OK
}

@_cdecl("gc_reset")
public func gc_reset() {
	if #available(macOS 12.3, *) {
		for (_, s) in streams { (s as? StreamSession)?.stop() }
		SCK.content = nil
		SCK.filters = [:]
	}
	streams = [:]
}

@_cdecl("gc_stats_json")
public func gc_stats_json(_ buf: UnsafeMutablePointer<CChar>?, _ cap: Int32) -> Int32 {
	var items: [String] = []
	if #available(macOS 12.3, *) {
		for (id, o) in streams {
			guard let s = o as? StreamSession else { continue }
			s.lock.lock()
			let err = (s.stopError ?? "").replacingOccurrences(of: "\"", with: "'")
			items.append("{\"display\":\(id),\"complete\":\(s.complete),\"idle\":\(s.idle),\"other\":\(s.other),\"running\":\(s.scStream != nil),\"stopError\":\"\(err)\"}")
			s.lock.unlock()
		}
	}
	return copyOut("{\"streams\":[\(items.joined(separator: ","))]}", buf, cap)
}

@_cdecl("gc_capture_piece")
public func gc_capture_piece(
	_ backend: Int32, _ displayId: UInt64, _ gx: Double, _ gy: Double, _ lx: Double, _ ly: Double,
	_ w: Double, _ h: Double, _ dx: Int32, _ dy: Int32, _ dw: Int32, _ dh: Int32,
	_ out: UnsafeMutablePointer<UInt8>?, _ outStride: Int32, _ outLen: UInt64
) -> Int32 {
	guard let out = out, dw > 0, dh > 0, dx >= 0, dy >= 0, Int(outStride) >= Int(dx + dw) * 4,
		UInt64(outStride) * UInt64(dy + dh) <= outLen
	else {
		setErr("bad destination d=\(dx),\(dy) \(dw)x\(dh) stride=\(outStride) len=\(outLen)")
		return GC_E_ARGS
	}
	guard #available(macOS 12.3, *) else {
		setErr("ScreenCaptureKit needs macOS 12.3+")
		return GC_E_UNSUPPORTED
	}
	let id = CGDirectDisplayID(truncatingIfNeeded: displayId)
	guard let filter = SCK.filter(id) else { return GC_E_NO_DISPLAY }
	let cfg = SCK.config(lx, ly, w, h, Int(dw), Int(dh))

	switch backend {
	case BK_SCK_SHOT:
		guard #available(macOS 14.0, *) else {
			setErr("SCScreenshotManager needs macOS 14+; use the SCStream backend")
			return GC_E_UNSUPPORTED
		}
		let (sb, e, timedOut) = blocking(3) { (done: @escaping (CMSampleBuffer?, Error?) -> Void) in
			SCScreenshotManager.captureSampleBuffer(contentFilter: filter, configuration: cfg) { sb, e in done(sb, e) }
		}
		if timedOut {
			setErr("SCScreenshotManager timed out")
			return GC_E_TIMEOUT
		}
		if let e = e {
			let (code, msg) = describe(e)
			setErr("SCScreenshotManager: \(msg)")
			return code == 0 ? GC_E_API : code
		}
		guard let sb = sb, let pb = CMSampleBufferGetImageBuffer(sb) else {
			setErr("SCScreenshotManager returned no image buffer")
			return GC_E_NO_FRAME
		}
		return blit(pb, out, Int(outStride), Int(dx), Int(dy), Int(dw), Int(dh))

	case BK_SCK_STREAM:
		let key = "\(lx),\(ly),\(w),\(h),\(dw),\(dh),\(optCursor),\(optStreamFps)"
		var s = streams[id] as? StreamSession
		if s == nil || s!.scStream == nil || s!.key != key {
			if s == nil {
				s = StreamSession(displayID: id)
				streams[id] = s
			}
			let r = s!.start(filter: filter, cfg: cfg, key: key)
			if r != GC_OK { return r }
		}
		// Wait (max 1 s) for the first complete frame; afterwards always reuse the latest.
		let deadline = Date().addingTimeInterval(1)
		while true {
			s!.lock.lock()
			let pb = s!.latest
			let stopErr = s!.stopError
			s!.lock.unlock()
			if let pb = pb { return blit(pb, out, Int(outStride), Int(dx), Int(dy), Int(dw), Int(dh)) }
			if let stopErr = stopErr {
				setErr("SCStream stopped: \(stopErr)")
				return GC_E_API
			}
			if Date() > deadline {
				setErr("SCStream: no frame within 1 s")
				return GC_E_NO_FRAME
			}
			usleep(2000)
		}

	default:
		setErr("unknown backend \(backend)")
		return GC_E_BACKEND
	}
}
