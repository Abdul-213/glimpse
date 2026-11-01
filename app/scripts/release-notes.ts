// Release notes for a GitHub Release (GLIM-62, .github/workflows/release.yml).
//
//   bun app/scripts/release-notes.ts <version> [commit-subjects-file] > notes.md
//
// The body is the version's section of CHANGELOG.md ("## [0.1.0] - 2026-11-20"). Without one,
// it is generated from the ticket commits since the previous release (subjects like
// "GLIM-65: Snip translation popup near the selection", one line per ticket), so a release
// never goes out with empty notes; the owner edits the draft before publishing. Then the same
// install and verification notes every release needs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The body of `## [<version>]` (or `## <version>`) in a Keep a Changelog file, or null. */
export function changelogSection(changelog: string, version: string): string | null {
	const lines = changelog.split(/\r?\n/);
	const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(?:\\s|$)`);
	const start = lines.findIndex((l) => heading.test(l));
	if (start < 0) return null;
	let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
	if (end < 0) end = lines.length;
	// Drop link reference definitions ("[0.1.0]: https://...") that trail the last section.
	const body = lines
		.slice(start + 1, end)
		.filter((l) => !/^\[[^\]]+\]:\s*\S+/.test(l))
		.join("\n")
		.trim();
	return body.length > 0 ? body : null;
}

/**
 * One bullet per ticket from commit subjects (newest first, as `git log` prints them): the
 * oldest "GLIM-<n>: ..." subject of each ticket, oldest ticket first. Merge commits and
 * commits without a ticket key are left out.
 */
export function ticketNotes(subjects: readonly string[]): string {
	const seen = new Map<string, string>();
	for (const subject of [...subjects].reverse()) {
		const m = /^(GLIM-\d+):\s*(.+)$/.exec(subject.trim());
		if (!m?.[1] || !m[2] || seen.has(m[1])) continue;
		seen.set(m[1], m[2].trim());
	}
	return [...seen].map(([key, title]) => `- ${title} (${key})`).join("\n");
}

export interface ReleaseNotesInput {
	readonly version: string;
	readonly changelog: string;
	readonly subjects: readonly string[];
}

export function releaseNotes({ version, changelog, subjects }: ReleaseNotesInput): string {
	const section = changelogSection(changelog, version);
	const generated = ticketNotes(subjects);
	const changes =
		section ??
		(generated
			? `_No CHANGELOG.md entry for ${version}; generated from the ticket commits since the last release._\n\n${generated}`
			: "_No CHANGELOG.md entry and no ticket commits found._");
	return `${changes}

## Downloads

| File | For |
|---|---|
| \`glimpse-${version}-windows-x64-setup.zip\` | Windows 10/11 (x64) installer: unzip, run \`Glimpse-Setup.exe\` |
| \`glimpse-${version}-windows-x64.zip\` | Windows portable: unzip anywhere, run \`Glimpse\\bin\\launcher.exe\` |
| \`glimpse-${version}-macos-arm64.dmg\` | macOS on Apple Silicon: open, drag Glimpse to Applications |
| \`glimpse-${version}-macos-arm64.zip\` | The same Mac app as a zip |
| \`SHA256SUMS\` | SHA-256 checksums of the files above |

There is no Intel Mac build yet.

These builds are not code-signed or notarized. Windows SmartScreen asks first (*More info* ->
*Run anyway*); on macOS, open Glimpse once, then allow it in System Settings -> Privacy &
Security -> *Open Anyway*. See the README for details.

Check a download: \`sha256sum -c SHA256SUMS --ignore-missing\` (Linux/WSL),
\`shasum -a 256 -c SHA256SUMS --ignore-missing\` (macOS), or compare
\`Get-FileHash <file>\` (PowerShell) with the line in SHA256SUMS.
`;
}

if (import.meta.main) {
	const [version, subjectsFile] = process.argv.slice(2);
	if (!version) {
		console.error("usage: bun app/scripts/release-notes.ts <version> [commit-subjects-file]");
		process.exit(2);
	}
	const root = resolve(import.meta.dir, "..", "..");
	let changelog = "";
	try {
		changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
	} catch {
		// No changelog yet: generated notes only.
	}
	const subjects = subjectsFile ? readFileSync(subjectsFile, "utf8").split(/\r?\n/).filter(Boolean) : [];
	process.stdout.write(releaseNotes({ version, changelog, subjects }));
}
