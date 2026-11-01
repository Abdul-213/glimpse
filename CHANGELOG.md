# Changelog

User-facing changes per release, newest first ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
style). The release workflow (`.github/workflows/release.yml`) uses the section whose heading
matches the tag (`## [0.1.0] - 2026-11-20` for `v0.1.0`) as the GitHub Release notes. Without
one it generates a list from the `GLIM-<n>:` commits since the previous tag.

To release: move the Unreleased entries under a new version heading, set that version in
`package.json` and `app/package.json`, merge to `main`, tag `v<version>` and push the tag. The
workflow builds Windows and macOS and leaves a **draft** release for the owner to publish.

## [Unreleased]
