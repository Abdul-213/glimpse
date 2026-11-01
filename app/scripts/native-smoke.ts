// Loads the freshly built native helper through the real bindings and calls the cheap
// entry points, so CI catches a symbol or ABI mismatch between C and TypeScript.
// Used by .github/workflows/native.yml on windows-latest and macos-latest.
//
//   bun app/scripts/native-smoke.ts [--try-capture]
//
// Exits 1 if the helper doesn't load. --try-capture also attempts one small capture and
// prints the outcome without failing (CI runners may have no usable desktop or no
// Screen Recording grant).
import { rect } from "@glimpse/core";
import { loadAnnounceNative } from "../src/bun/native/announce.ts";
import { FRAME_PALETTE_ORDER, type FrameNativeBinding, rgbaOf } from "../src/bun/native/frame.ts";
import { loadMacNative } from "../src/bun/native/macos.ts";
import type { SessionEventKind, SessionNativeBinding } from "../src/bun/native/session.ts";
import { loadWindowsCapture } from "../src/bun/native/windows.ts";
import { MacCaptureSource } from "../src/bun/services/capture/macos.ts";
import { displaysFromMac, displaysFromWindows } from "../src/bun/services/capture/native-displays.ts";
import { WindowsCaptureSource } from "../src/bun/services/capture/windows.ts";
import { FRAME_COLORS } from "../src/bun/services/live/frame-layout.ts";
import { macWindows, windowsWindows } from "../src/bun/services/picker/window-list.ts";

// Picker helpers (GLIM-91): cheap, no permission needed, so failures here fail the job.
function pickerSmoke(binding: { listWindows(): unknown[]; focusSave(): number }, logical: () => unknown[]): void {
	const raw = binding.listWindows();
	console.log(`windows: ${raw.length} listed; logical:`, JSON.stringify(logical().slice(0, 5)));
	console.log("focus save:", binding.focusSave());
}

// Pinned Live frame (GLIM-90): create, style, place, show, read back what the OS reports,
// highlight, hide, destroy. Cheap and permission-free, so a failure fails the job.
function frameSmoke(binding: FrameNativeBinding, check: (info: Record<string, number>) => string[]): void {
	const h = binding.frameCreate();
	binding.frameSetStyle(h, {
		paused: false,
		palette: Uint32Array.from(FRAME_PALETTE_ORDER.map((k) => rgbaOf(FRAME_COLORS[k]))),
		tag: 1,
		tagText: "Live",
		tagBelow: false,
	});
	binding.frameSetRect(h, rect(200, 200, 320, 90), 1);
	binding.frameShow(h, true);
	binding.frameSetHighlight(h, rect(220, 220, 120, 24));
	const info = binding.frameInfo(h);
	console.log("live frame:", JSON.stringify(info), "window id", binding.frameWindowId(h));
	binding.frameSetStyle(h, {
		paused: true,
		palette: Uint32Array.from(FRAME_PALETTE_ORDER.map((k) => rgbaOf(FRAME_COLORS[k]))),
		tag: 3,
		tagText: "☁︎ Live · Google",
		tagBelow: true,
	});
	binding.frameSetHighlight(h, null);
	binding.frameShow(h, false);
	binding.frameDestroy(h);
	const problems = info ? check(info) : ["no frame info"];
	if (problems.length > 0) {
		console.log(`live frame problems: ${problems.join("; ")}`);
		process.exit(1);
	}
}

// Lock / sleep notifications (GLIM-119): start the observer, have the helper deliver each kind
// through its real path (macOS: a distributed notification; Windows: the real
// WM_WTSSESSION_CHANGE / WM_POWERBROADCAST to the watcher window), and check every one reaches
// this worker through the threadsafe callback. A failure fails the job.
async function sessionSmoke(binding: SessionNativeBinding): Promise<void> {
	const got: string[] = [];
	const start = binding.sessionStart((kind, source) => got.push(`${kind}:${source}`));
	console.log(`session start ${start}:`, JSON.stringify(binding.sessionInfo()));
	if (start !== 0) process.exit(1);
	const kinds: SessionEventKind[] = ["lock", "unlock", "sleep", "wake"];
	for (const kind of kinds) {
		const r = binding.sessionSimulate(kind);
		if (r !== 0) console.log(`session simulate ${kind}: status ${r}`);
	}
	for (let i = 0; i < 40 && got.length < kinds.length; i++) {
		binding.sessionPump(50);
		await Bun.sleep(10);
	}
	binding.sessionStop();
	console.log("session events:", JSON.stringify(got), "after stop:", JSON.stringify(binding.sessionInfo()));
	const missing = kinds.filter((k) => !got.some((g) => g.startsWith(`${k}:`)));
	if (missing.length > 0) {
		console.log(`session events missing: ${missing.join(", ")}`);
		process.exit(1);
	}
}

const tryCapture = Bun.argv.includes("--try-capture");

async function attempt(label: string, run: () => Promise<{ width: number; height: number }>): Promise<void> {
	// A capture may fail on a runner, but it must settle: on macOS the result comes back
	// through the helper's completion callback (GLIM-97), and a lost callback would hang.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const hung = new Promise<"hung">((resolve) => {
		timer = setTimeout(() => resolve("hung"), 20_000);
	});
	try {
		const f = await Promise.race([run(), hung]);
		if (f === "hung") {
			console.log(`${label}: never settled within 20 s`);
			process.exit(1);
		}
		console.log(`${label}: ok ${f.width}x${f.height}`);
	} catch (e) {
		console.log(`${label}: failed (allowed in CI): ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		clearTimeout(timer);
	}
}

// Screen-reader announcements (GLIM-92): load the two symbols, ask whether a reader runs, and
// on macOS post one low-priority announcement (Windows needs a real window's HWND).
{
	const { status, native } = loadAnnounceNative();
	console.log("announce:", JSON.stringify(status));
	if (!native) process.exit(1);
	console.log("screen reader active:", native.screenReaderActive());
	if (process.platform === "darwin")
		console.log("announce posted:", native.announce(null, "Glimpse native smoke", "low"));
}

if (process.platform === "win32") {
	const { status, binding } = loadWindowsCapture();
	console.log("glimpse.dll:", JSON.stringify(status));
	if (!binding) process.exit(1);
	const physical = binding.physicalDisplays();
	console.log("monitors:", JSON.stringify(physical));
	pickerSmoke(binding, () => windowsWindows(binding.listWindows(), displaysFromWindows(physical), physical));
	await sessionSmoke(binding);
	frameSmoke(binding, (info) => {
		const problems: string[] = [];
		const ex = info["exStyle"] ?? 0;
		// WS_EX_TOPMOST 0x8, WS_EX_TRANSPARENT 0x20, WS_EX_TOOLWINDOW 0x80, WS_EX_LAYERED 0x80000, WS_EX_NOACTIVATE 0x8000000
		for (const [name, bit] of [
			["TOPMOST", 0x8],
			["TRANSPARENT", 0x20],
			["TOOLWINDOW", 0x80],
			["LAYERED", 0x80000],
			["NOACTIVATE", 0x8000000],
		] as const) {
			if ((ex & bit) === 0) problems.push(`WS_EX_${name} missing`);
		}
		if (info["affinity"] !== 0x11) problems.push(`display affinity ${info["affinity"]} (want WDA_EXCLUDEFROMCAPTURE)`);
		if (info["clickThrough"] !== 1) problems.push("WindowFromPoint hit the frame");
		if (info["visible"] !== 1) problems.push("not visible after show");
		return problems;
	});
	if (tryCapture && physical.length > 0) {
		const source = new WindowsCaptureSource({ binding, shellDisplays: () => displaysFromWindows(physical) });
		await attempt("GDI snip 64x64", () => source.capture(rect(0, 0, 64, 64)));
		await attempt("DXGI live 64x64", async () => {
			const s = await source.openSession(rect(0, 0, 64, 64), { fps: 4 });
			try {
				return await s.next();
			} finally {
				s.close();
			}
		});
		source.dispose();
	}
} else if (process.platform === "darwin") {
	const { status, binding } = loadMacNative();
	console.log("libglimpse.dylib:", JSON.stringify(status));
	if (!binding) process.exit(1);
	const displays = binding.displays();
	console.log("displays:", JSON.stringify(displays), "screen recording granted:", binding.preflight());
	binding.setExcludedWindows([]);
	pickerSmoke(binding, () => macWindows(binding.listWindows()));
	await sessionSmoke(binding);
	frameSmoke(binding, (info) => {
		const problems: string[] = [];
		if (info["ignoresMouseEvents"] !== 1) problems.push("ignoresMouseEvents is off");
		if (info["level"] !== 101) problems.push(`level ${info["level"]} (want 101)`);
		if (info["sharingType"] !== 0) problems.push(`sharingType ${info["sharingType"]} (want none)`);
		if (info["canBecomeKey"] !== 0) problems.push("the panel can become key");
		if (info["visible"] !== 1) problems.push("not visible after show");
		return problems;
	});
	// Carbon hot keys (GLIM-44): install the handler, register an unlikely chord, release it.
	const init = binding.hotkeyInit(() => {});
	const reg = binding.hotkeyRegister(0, 0x50, 0x1100); // Ctrl+Cmd+F19
	console.log(`hotkey init ${init}, register Ctrl+Cmd+F19 ${reg}`);
	binding.hotkeyShutdown();
	if (init !== 0 || reg !== 0) process.exit(1);
	if (tryCapture && displays.length > 0) {
		const source = new MacCaptureSource({ binding, shellDisplays: () => displaysFromMac(displays) });
		await attempt("SCK snip 64x64", () => source.capture(rect(0, 0, 64, 64)));
		await attempt("SCK live 64x64", async () => {
			const s = await source.openSession(rect(0, 0, 64, 64), { fps: 4 });
			try {
				return await s.next();
			} finally {
				s.close();
			}
		});
		await attempt("SCK loupe stream 15x15", async () => {
			const d = displays[0];
			if (!d) throw new Error("no display");
			const h = await binding.streamOpen(
				d.id,
				{ ...d.bounds, x: 0, y: 0 },
				Math.round(d.bounds.width * d.scale),
				Math.round(d.bounds.height * d.scale),
				30,
			);
			try {
				const out = new Uint8Array(15 * 15 * 4);
				for (let i = 0; i < 50; i++) {
					if (binding.streamSample(h, 0, 0, 15, out) !== null) return { width: 15, height: 15 };
					await Bun.sleep(20);
				}
				throw new Error("no frame within 1 s");
			} finally {
				binding.streamClose(h);
			}
		});
		source.dispose();
	}
} else {
	console.log(`no native helper on ${process.platform}`);
}
