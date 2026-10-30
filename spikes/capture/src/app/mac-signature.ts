// macOS: who will TCC think we are? Reports the responsible bundle and its code
// signature (identifier, cdhash, team, designated requirement) so each
// permission test run records exactly which identity was granted or denied.
import { spawnSync } from "node:child_process";

export interface SignatureInfo {
	bundlePath: string | null;
	runningFromBundle: boolean;
	warning?: string;
	identifier?: string;
	signature?: string; // "adhoc" or authority chain
	teamIdentifier?: string;
	cdhash?: string;
	designatedRequirement?: string;
	raw?: string;
}

export function bundlePathFrom(execPath = process.execPath): string | null {
	const m = /^(.*?\.app)\/Contents\//.exec(execPath);
	return m ? m[1]! : null;
}

export function parseCodesign(stderr: string): Partial<SignatureInfo> {
	const get = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(stderr)?.[1]?.trim();
	const authorities = [...stderr.matchAll(/^Authority=(.*)$/gm)].map((m) => m[1]!.trim());
	const adhoc = /^Signature=adhoc$/m.test(stderr) || /flags=.*adhoc/.test(stderr);
	return {
		identifier: get("Identifier"),
		teamIdentifier: get("TeamIdentifier"),
		cdhash: get("CDHash"),
		signature: adhoc ? "adhoc" : authorities.length ? authorities.join(" < ") : "unsigned or unknown",
	};
}

export function signatureInfo(): SignatureInfo {
	const bundlePath = bundlePathFrom();
	if (process.platform !== "darwin") return { bundlePath, runningFromBundle: false };
	if (!bundlePath) {
		return {
			bundlePath: null,
			runningFromBundle: false,
			warning:
				"Not running from a .app bundle. TCC attributes Screen Recording to the *responsible process* " +
				"(Terminal / iTerm / VS Code), so permission results here say nothing about Glimpse. Use the .app for permission tests.",
		};
	}
	const dv = spawnSync("codesign", ["-dvvv", bundlePath], { encoding: "utf8" });
	const dr = spawnSync("codesign", ["-d", "-r-", bundlePath], { encoding: "utf8" });
	const req = /designated => (.*)$/m.exec(`${dr.stdout}\n${dr.stderr}`)?.[1]?.trim();
	return {
		bundlePath,
		runningFromBundle: true,
		...parseCodesign(dv.stderr ?? ""),
		designatedRequirement: req ?? "(none)",
		raw: (dv.stderr ?? "").trim(),
	};
}
