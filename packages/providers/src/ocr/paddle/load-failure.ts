// A clearer message when onnxruntime's native library can't be loaded (GLIM-111). Windows says
// only "The specified module could not be found" when a DLL that onnxruntime.dll imports is
// missing. Builds ship the Visual C++ runtime next to it, so this should not happen; if it does
// (a hand-assembled build, a damaged install), the log says what to install instead of a bare
// loader error.

/** Microsoft's permanent download link for the latest VC++ 2015-2022 redistributable (x64). */
export const VC_REDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe";

const MISSING_DLL = /specified module could not be found|vcruntime140|msvcp140|\berror 126\b/i;

/** `message` with a hint appended when it looks like a missing Visual C++ runtime DLL. */
export function explainOrtLoadFailure(message: string): string {
	if (!MISSING_DLL.test(message)) return message;
	return (
		`${message} (onnxruntime could not load a DLL it needs. On Windows this is usually the Microsoft ` +
		`Visual C++ runtime: reinstall Glimpse, or install the Visual C++ Redistributable from ${VC_REDIST_URL})`
	);
}
