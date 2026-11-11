import { CaptureError, type CaptureFrame, type CaptureSession, type CaptureSource, type Display } from "@glimpse/core";

/**
 * Stands in when no backend could be loaded (native helper missing, unsupported OS),
 * so the app still starts and every capture fails with a clear `unavailable` error.
 */
export class UnavailableCaptureSource implements CaptureSource {
	readonly backend = "unavailable";
	readonly exclusion = "none" as const;

	constructor(
		readonly reason: string,
		private readonly shellDisplays: () => readonly Display[] = () => [],
	) {}

	displays(): readonly Display[] {
		return this.shellDisplays();
	}

	async capture(): Promise<CaptureFrame> {
		throw new CaptureError("unavailable", `screen capture is unavailable: ${this.reason}`);
	}

	async openSession(): Promise<CaptureSession> {
		throw new CaptureError("unavailable", `screen capture is unavailable: ${this.reason}`);
	}

	setExcludedWindows(): void {}

	dispose(): void {}
}
