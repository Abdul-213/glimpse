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
import { loadMacNative } from "../src/bun/native/macos.ts";
import { loadWindowsCapture } from "../src/bun/native/windows.ts";
import { MacCaptureSource } from "../src/bun/services/capture/macos.ts";
import { displaysFromMac, displaysFromWindows } from "../src/bun/services/capture/native-displays.ts";
import { WindowsCaptureSource } from "../src/bun/services/capture/windows.ts";
import { macWindows, windowsWindows } from "../src/bun/services/picker/window-list.ts";

// Picker helpers (GLIM-91): cheap, no permission needed, so failures here fail the job.
function pickerSmoke(binding: { listWindows(): unknown[]; focusSave(): number }, logical: () => unknown[]): void {
	const raw = binding.listWindows();
	console.log(`windows: ${raw.length} listed; logical:`, JSON.stringify(logical().slice(0, 5)));
	console.log("focus save:", binding.focusSave());
}

const tryCapture = Bun.argv.includes("--try-capture");

async function attempt(label: string, run: () => Promise<{ width: number; height: number }>): Promise<void> {
	try {
		const f = await run();
		console.log(`${label}: ok ${f.width}x${f.height}`);
	} catch (e) {
		console.log(`${label}: failed (allowed in CI): ${e instanceof Error ? e.message : String(e)}`);
	}
}

if (process.platform === "win32") {
	const { status, binding } = loadWindowsCapture();
	console.log("glimpse.dll:", JSON.stringify(status));
	if (!binding) process.exit(1);
	const physical = binding.physicalDisplays();
	console.log("monitors:", JSON.stringify(physical));
	pickerSmoke(binding, () => windowsWindows(binding.listWindows(), displaysFromWindows(physical), physical));
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
	if (tryCapture && displays.length > 0) {
		const source = new MacCaptureSource({ binding, shellDisplays: () => displaysFromMac(displays) });
		await attempt("SCK snip 64x64", () => source.capture(rect(0, 0, 64, 64)));
		await attempt("SCK loupe stream 15x15", async () => {
			const d = displays[0];
			if (!d) throw new Error("no display");
			const h = binding.streamOpen(
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
