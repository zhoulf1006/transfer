# ADR-0023: Notarize every published macOS build; local packages are signed only; no certificate, no package

- Status: Accepted (2026-10-09)

## Context

ADR-0012 notarized only formal releases: prereleases were signed but not notarized, CI without the certificate secret produced an unsigned artifact, and a local build on a machine without the certificate silently came out unsigned. Testers therefore ran a different kind of build from the one users would get, removed the quarantine attribute by hand, and never exercised the notarization path before a formal tag. Packaging also ran the app's notarization inside electron-builder, which submits whenever Apple credentials are present in the environment, and the scripts were named after mechanisms (`dist:mac:sign` signed *and* notarized).

## Options

1. **One packaging path for everything published, a signed-only local path, and no unsigned path; signing and notarization as separate step scripts composed by two entry commands named after their environment**
2. Keep ADR-0012's tiering (prereleases signed only) — rejected: a prerelease would still differ from the release it previews, and the notarization path would first run on the formal tag.
3. Keep an unsigned tier for machines without the certificate — rejected: an unsigned or ad-hoc build is not a usable distributable, and a green job producing one hides a missing secret. Packaging fails instead.
4. Keep the app's notarization inside electron-builder and only rename the scripts — rejected: built-in notarization fires whenever credentials are loaded, so a local build could submit to Apple unnoticed. A spike on 1.2.1 showed the split works: building the DMG from an already stapled app with the prepackaged option does not re-sign it, on all three architectures.
5. Make release "the local build plus a notarization step" — rejected: the app inside a DMG built before the app was notarized carries no ticket, and it cannot be added once the DMG exists.

## Decision

We adopt **option 1**:

- Formal releases and prereleases both run the release path: each `.app` and each DMG is signed with Developer ID, notarized and stapled, and passes the full gate before upload. The tag suffix decides only the GitHub Pre-release marking and whether R2 is synced.
- Local packaging, including a manual CI run without the verification switch, signs with Developer ID and never notarizes; built-in notarization is switched off in the builder config.
- Without the Developer ID certificate every packaging command fails; dev mode neither signs nor notarizes.
- Four step scripts (`mac:sign`, `mac:notarize-app`, `mac:dmg`, `mac:notarize-dmg`) are composed by `dist:mac:local` and `dist:mac:release`.

This supersedes ADR-0012's prerelease rule; its fail-closed gate for published builds stays.

## Consequences

- Positive: every published DMG and the app inside it pass Gatekeeper offline, prereleases included; a missing certificate or credential turns the job red instead of shipping a degraded build; a local build cannot reach Apple.
- Negative: a prerelease now waits on Apple like a formal release — two submissions per architecture, six per version — so iteration through prereleases is slower and depends on Apple's service being up.
- Neutral: the Mac App Store line is untouched; Windows packaging is unchanged.

## Sources

The cross-project distribution policy and the layout spike (zhoulf1006/skillshed#13, 2026-10-09); [specs/mac-distribution.md](../specs/mac-distribution.md); [ops/mac-signing.md](../ops/mac-signing.md); ADR-0012.
