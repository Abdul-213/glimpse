// GLIM-62: release notes from CHANGELOG.md, or generated from ticket commits.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { changelogSection, releaseNotes, ticketNotes } from "../scripts/release-notes.ts";

const CHANGELOG = `# Changelog

## [Unreleased]
- Something coming

## [0.2.0] - 2026-12-01
### Added
- Live translation

## 0.1.0
- First release

[0.2.0]: https://github.com/Abdul-213/glimpse/releases/tag/v0.2.0
`;

describe("changelogSection", () => {
	test("finds a version's body with or without brackets, and only that section", () => {
		expect(changelogSection(CHANGELOG, "0.2.0")).toBe("### Added\n- Live translation");
		expect(changelogSection(CHANGELOG, "0.1.0")).toBe("- First release");
		expect(changelogSection(CHANGELOG, "0.3.0")).toBeNull();
		// "0.1.0" must not match "0.1.01" or a regex wildcard.
		expect(changelogSection("## [0.1.01]\n- x\n", "0.1.0")).toBeNull();
		expect(changelogSection("## [0x1x0]\n- x\n", "0.1.0")).toBeNull();
		expect(changelogSection("## [0.4.0]\n\n## [0.3.0]\n- y\n", "0.4.0")).toBeNull();
	});

	test("the repo's CHANGELOG.md has an Unreleased section", () => {
		const text = readFileSync(resolve(import.meta.dir, "..", "..", "CHANGELOG.md"), "utf8");
		expect(text).toContain("## [Unreleased]");
	});
});

describe("ticketNotes", () => {
	test("one line per ticket, its first commit, oldest first; merges and untagged commits dropped", () => {
		const subjects = [
			"Merge pull request #62 from Abdul-213/glim-59-pin-live",
			"GLIM-59: As a user, I can pin a region for live translation",
			"GLIM-48: idle back-off to 2 fps",
			"desktop.yml: size the DMG explicitly",
			"GLIM-48: Live capture loop at 2-4 fps",
		];
		expect(ticketNotes(subjects)).toBe(
			"- Live capture loop at 2-4 fps (GLIM-48)\n- As a user, I can pin a region for live translation (GLIM-59)",
		);
		expect(ticketNotes([])).toBe("");
	});
});

describe("releaseNotes", () => {
	test("uses the changelog section when there is one, else the generated list; always the downloads", () => {
		const fromChangelog = releaseNotes({ version: "0.2.0", changelog: CHANGELOG, subjects: ["GLIM-1: x"] });
		expect(fromChangelog.startsWith("### Added\n- Live translation")).toBe(true);
		expect(fromChangelog).not.toContain("(GLIM-1)");
		for (const file of [
			"glimpse-0.2.0-windows-x64-setup.zip",
			"glimpse-0.2.0-windows-x64.zip",
			"glimpse-0.2.0-macos-arm64.dmg",
			"glimpse-0.2.0-macos-arm64.zip",
			"SHA256SUMS",
		]) {
			expect(fromChangelog).toContain(file);
		}
		const generated = releaseNotes({ version: "0.3.0", changelog: CHANGELOG, subjects: ["GLIM-7: Tray menu"] });
		expect(generated).toContain("No CHANGELOG.md entry for 0.3.0");
		expect(generated).toContain("- Tray menu (GLIM-7)");
	});
});
