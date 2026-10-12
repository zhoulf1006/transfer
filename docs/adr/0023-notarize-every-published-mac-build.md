# ADR-0023: Notarize every published macOS build; local packages are signed only; no certificate, no package

- Status: Accepted (2026-10-12)

## Context

ADR-0012 notarized only formal releases: prereleases were signed but not notarized, CI without the certificate secret produced an unsigned artifact, and a local build on a machine without the certificate silently came out unsigned. Testers therefore ran a different kind of build from the one users would get, removed the quarantine attribute by hand, and never exercised the notarization path before a formal tag. Packaging also ran the app's notarization through electron-builder's built-in notarization, which submits whenever Apple credentials are present in the environment and only warns when they are missing, and the scripts were named after mechanisms (`dist:mac:sign` signed *and* notarized).

## Options

1. **One packaging path for everything published, a signed-only local path, and no unsigned path; each packaging is one electron-builder call, and the release call notarizes each `.app` with our own code from the builder's afterSign hook**
2. Keep ADR-0012's tiering (prereleases signed only) — rejected: a prerelease would still differ from the release it previews, and the notarization path would first run on the formal tag.
3. Keep an unsigned tier for machines without the certificate — rejected: an unsigned or ad-hoc build is not a usable distributable, and a green job producing one hides a missing secret. Packaging fails instead.
4. Use electron-builder's built-in notarization (`mac.notarize`) for the `.app` — rejected: it fires whenever credentials are loaded, so a local build could submit to Apple unnoticed; it only warns when they are missing, so a release could ship an app without a ticket; and it keeps no Apple log.
5. Split packaging into separate builder calls: sign the apps with the `dir` target, notarize them as a step of their own, then build each DMG from its stapled app with the prepackaged option — rejected on 2026-10-12, after it had been implemented and run for real. It works (a spike on 1.2.1 and the real runs showed the prepackaged build does not re-sign the app), but it leaves the builder's ordinary path: whatever the builder does only inside a single build is lost — it writes `app-update.yml` into an app only when the same call also builds a DMG or zip — and correctness rests on the prepackaged option continuing to leave the app untouched across upgrades.
6. Make release "the local build plus a notarization step" — rejected: the app inside a DMG built before the app was notarized carries no ticket, and it cannot be added once the DMG exists.
7. Notarize and staple only the DMG, as Apple's guidance describes (the DMG's ticket covers the nested app and is ingested when the DMG is first opened) — deferred: it would halve the submissions and need no hook, but it reverses the two-ticket conclusion of the notarization postmortem, whose offline-launch failure was inferred, not measured. Restart condition: an offline launch test of an app copied out of a DMG-only-notarized image (for example the published 1.0.0 DMG, which was notarized that way).

## Decision

We adopt **option 1**:

- Formal releases and prereleases both run the release path: each `.app` and each DMG is signed with Developer ID, notarized and stapled, and passes the full gate before upload. The tag suffix decides only the GitHub Pre-release marking and whether R2 is synced.
- Local packaging, including a manual CI run without the verification switch, signs with Developer ID and never notarizes. Built-in notarization is off in the builder config and on every builder command line.
- Without the Developer ID certificate every packaging command fails; dev mode neither signs nor notarizes.
- `dist:mac:local` and `dist:mac:release` each run one builder call. The release call adds the packaging script as the afterSign hook, which notarizes, logs and staples each `.app` after signing and before its DMG; the DMG gate (`mac:notarize-dmg`) runs after the build.

This supersedes ADR-0012's prerelease rule; its fail-closed gate for published builds stays.

## Consequences

- Positive: every published DMG and the app inside it carry their own tickets, prereleases included; a missing certificate or credential turns the job red instead of shipping a degraded build; a local build cannot reach Apple; packaging stays on the builder's ordinary single-call path, so its in-build behaviour (such as `app-update.yml`) is kept.
- Negative: a prerelease now waits on Apple like a formal release — two submissions per architecture, six per version — so iteration through prereleases is slower and depends on Apple's service being up. The app notarization is not a command of its own: it runs only inside a release build.
- Neutral: the Mac App Store line is untouched (the hook skips it); Windows packaging is unchanged.

## Sources

The cross-project distribution policy and the layout spike (zhoulf1006/skillshed#13, 2026-10-09); the structure change and the research behind options 4, 5 and 7 (2026-10-12): Apple's notarization documentation ("Customizing the notarization workflow") and DTS guidance on stapling disk images, electron-builder 26.17.0's source and notarization docs, Signal Desktop's afterSign / afterAllArtifactBuild notarization; [specs/mac-distribution.md](../specs/mac-distribution.md); [ops/mac-signing.md](../ops/mac-signing.md); [postmortems/notarization-staple-target.md](../postmortems/notarization-staple-target.md); ADR-0012.
