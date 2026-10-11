# macOS distribution (Developer ID / DMG)

> Related: no features entry (distribution channels are not in the feature catalogue) · ADR-0010 · ADR-0023 · [ops/mac-signing.md](../ops/mac-signing.md)

## Problem Statement

Transfer ships three macOS DMGs (arm64, x64, universal) outside the App Store. A DMG that is not notarized, or whose app carries no stapled ticket, is blocked or flagged by Gatekeeper on the user's machine — and every way of producing such a build has looked green at the time: an unsigned CI artifact when the certificate secret was missing, a local build on a machine without the certificate, a prerelease that was signed but never notarized. Packaging commands named after mechanisms (`sign`, `package-signed`) also stopped matching what they do, so nobody could tell from a name whether a build would be notarized.

## Solution

Every packaged macOS build is signed with Developer ID; without the certificate, packaging fails instead of producing anything. Builds that are published — formal releases and prereleases alike — notarize and staple both each `.app` and each DMG and pass the full gate before upload. Local packaging signs only, with notarization switched off explicitly. Signing and notarization are separate step scripts, and two entry commands named after their environment compose them. Dev mode neither signs nor notarizes.

## User Stories

### mac-distribution::US-001 Publish a formal release

As the publisher, I want a clean version tag to produce notarized DMGs for every architecture, so that users can open the download and the app it contains on any Mac, even offline.

- mac-distribution::US-001/AC-01: On a clean `v*` tag, the macOS job runs the release command: each architecture's `.app` is notarized and stapled before its DMG is built, and each DMG is then signed, notarized, stapled and passes the full gate (mac-distribution::REQ-005).
- mac-distribution::US-001/AC-02: The DMGs are published to the GitHub Release marked Latest, and synced to R2 with `latest.json` updated last, only after every architecture has passed the gate and the Windows job has succeeded.

### mac-distribution::US-002 Publish a prerelease

As the publisher, I want a prerelease tag to be packaged exactly like a formal release, so that testers get the same notarized build the formal release will be.

- mac-distribution::US-002/AC-01: On a `v*` tag ending in `-beta`, `-rc`, `-alpha` or `-dev`, the macOS job runs the same release command and gate as mac-distribution::US-001/AC-01.
- mac-distribution::US-002/AC-02: The DMGs are published to the GitHub Release marked Pre-release; R2 and `latest.json` are not touched.

### mac-distribution::US-003 Verify the release path without publishing

As a maintainer, I want to run the full release packaging from a manual CI run, so that I can prove notarization works before tagging.

- mac-distribution::US-003/AC-01: A manual run with `verify_formal_macos` checked runs the release command and the full gate.
- mac-distribution::US-003/AC-02: That run uploads only an Actions artifact: it creates no GitHub Release and does not touch R2 or `latest.json`.

### mac-distribution::US-004 Package from CI without releasing

As a maintainer, I want a manual CI run without the verification switch to give me a signed build, so that I can try a build from CI without waiting for Apple.

- mac-distribution::US-004/AC-01: A manual run without `verify_formal_macos` runs the local command: each DMG and the app inside it carry a Developer ID signature, and nothing is submitted to Apple, even though the Apple credentials exist as secrets.
- mac-distribution::US-004/AC-02: That run uploads only an Actions artifact, as in mac-distribution::US-003/AC-02.

### mac-distribution::US-005 Package locally

As a developer, I want one command that packages a signed build on my machine, so that I can install and run it like a user would.

- mac-distribution::US-005/AC-01: `dist:mac:local` on a machine with a valid Developer ID Application identity produces one DMG per configured architecture; each DMG and its app carry a Developer ID signature, and `codesign --verify --deep --strict` passes on each app.
- mac-distribution::US-005/AC-02: Nothing is submitted to Apple, including when the Apple credentials are loaded into the environment.

### mac-distribution::US-006 Run the release packaging locally

As the publisher, I want to run the release packaging on my own machine, so that I can reproduce or investigate a release without CI.

- mac-distribution::US-006/AC-01: With the Apple credentials loaded from the uncommitted local env file, `dist:mac:release` produces the same notarized, stapled and gated artifacts as the CI release path.

## Functional Requirements

### mac-distribution::REQ-001 No certificate, no package

Packaging without the Developer ID certificate fails instead of producing an unsigned or ad-hoc-signed build.

- mac-distribution::REQ-001/AC-01: Locally, when the keychain holds no valid Developer ID Application identity, `dist:mac:local` and `dist:mac:release` fail before building, and the message says to install the certificate and how to list identities that are present but untrusted.
- mac-distribution::REQ-001/AC-02: In CI, when the `CSC_LINK` secret is missing, the macOS job fails in every tier (tag, manual verification, manual packaging) with a message to configure the secret; no unsigned artifact is produced or uploaded.
- mac-distribution::REQ-001/AC-03: Whatever the certificate source, signing is confirmed on the built apps, not assumed from the build: a build whose app is not signed by a Developer ID Application identity fails before any DMG is made.

### mac-distribution::REQ-002 Release requires every Apple credential

- mac-distribution::REQ-002/AC-01: In CI, a release-tier run (tag or manual verification) missing any of `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` or `APPLE_TEAM_ID` fails before packaging starts.
- mac-distribution::REQ-002/AC-02: The app and DMG notarization steps refuse to run without all three credentials and fail with the missing names; they never skip.

### mac-distribution::REQ-003 The architecture set comes from the builder config (direct acceptance)

Every step works on exactly the architectures listed for the macOS DMG target in the builder config. A missing architecture, an extra one, or a leftover from another version fails the step before anything is submitted to Apple.

### mac-distribution::REQ-004 Notarization logs belong to the artifacts they describe

- mac-distribution::REQ-004/AC-01: Each accepted `.app` and DMG submission saves its Apple log, unmodified, next to the version's artifacts, and the CI artifact upload includes them.
- mac-distribution::REQ-004/AC-02: Rebuilding an app or a DMG removes any log a previous run left for it, so a locally packaged DMG never sits next to a log that claims it was notarized.

### mac-distribution::REQ-005 The release gate (direct acceptance)

Before upload, each DMG passes: the expected-set check; image verification, signature verification and a signature-content check (Developer ID Application, the expected Team ID, a secure timestamp) before submission; an Accepted submission whose log matches the submission, is Accepted and has no error-level issue; staple and validate; image verification again; Gatekeeper assessment of the DMG; and, inside the read-only mounted image, exactly one `Transfer.app` that passes strict deep verification and carries its own stapled ticket. Failure diagnostics never replace the original error, and the image is always detached.

## Constraints

### mac-distribution::CON-001 Command names (direct acceptance)

Applies to: `package.json` scripts. The entry commands are `dist:mac:local` and `dist:mac:release`; the step scripts are `mac:sign`, `mac:notarize-app`, `mac:dmg` and `mac:notarize-dmg`. `dist:mac:local` runs `mac:sign` then `mac:dmg`; `dist:mac:release` runs `mac:sign`, `mac:notarize-app`, `mac:dmg`, `mac:notarize-dmg` in that order. The previous names (`dist:mac`, `dist:mac:package-signed`, `notarize:mac:dmgs`, `dist:mac:sign`) are removed without aliases.

### mac-distribution::CON-002 Built-in notarization is off (direct acceptance)

Applies to: the builder config and every builder invocation in the step scripts. The builder config sets macOS notarization off permanently, so loaded Apple credentials never trigger a submission; every invocation also passes the off switch on the command line, so the local path stays safe even if the config is edited.

### mac-distribution::CON-003 Fixed order, no change after staple (direct acceptance)

Applies to: the release path. The app is notarized and stapled before its DMG is built; the DMG is built from that app without re-signing it; nothing modifies an app or DMG after it is stapled; every signature and notarization finishes before upload.

### mac-distribution::CON-004 Publishing follows the tag event (direct acceptance)

Applies to: the build workflow. Steps that create a GitHub Release run only on a tag event; the Pre-release marking follows the tag suffix; the R2 sync runs only on a clean tag and only after both platform jobs succeed. The manual verification switch never grants publishing.

### mac-distribution::CON-005 Unchanged neighbours (direct acceptance)

Applies to: the Windows job, the Mac App Store scripts and dev mode. Windows packaging and publishing, `dist:mas` / `dist:mas:dev` / `pkg:mas`, and `pnpm dev` behave as before this change; dev mode neither signs nor notarizes.

## Failure modes and boundaries

### Developer, local packaging

- No valid Developer ID identity in the keychain: fails before building (mac-distribution::REQ-001/AC-01). An identity that is present but untrusted (for example a missing intermediate certificate) counts as missing; the message shows how to list it.
- The build silently signs nothing or signs with another identity: caught on the built apps before any DMG (mac-distribution::REQ-001/AC-03).
- Apple credentials loaded in the shell while running `dist:mac:local`: still nothing is submitted (mac-distribution::US-005/AC-02, mac-distribution::CON-002).
- `mac:dmg` run without a prior `mac:sign` for this version, or with an architecture missing or extra: fails before building any DMG (mac-distribution::REQ-003).
- `dist:mac:local` run after a release run of the same version: the DMGs are rebuilt unnotarized and the earlier logs for them are removed (mac-distribution::REQ-004/AC-02).
- Interrupted run (Ctrl-C, crash) leaves a partial version directory: the next run rebuilds every app and DMG; a leftover file outside the expected set fails the gate rather than being published.

### Publisher, release packaging (CI or local)

- A release-tier CI run missing a credential: fails before packaging (mac-distribution::REQ-002/AC-01). Run locally without the credentials: the app notarization step fails with the missing names before submitting (mac-distribution::REQ-002/AC-02); no DMG is built.
- Apple rejects an app: the step fetches the log for diagnosis and fails with the original rejection; no DMG is built for any architecture.
- One architecture's app or DMG fails after another succeeded: the whole run fails and nothing is uploaded; the accepted submissions remain only as Apple-side records.
- Apple network error or timeout during submission: the step fails; rerunning the workflow repeats the whole release path.
- DMG-level failures (signature content, submission, log, staple, Gatekeeper, mounted app): as in mac-distribution::REQ-005; nothing is uploaded.
- Upload or Release creation fails after the gate passed: the job fails and the R2 sync does not run; rerunning is safe because nothing was published.
- R2 upload fails: the GitHub Release already exists; installers go up before `latest.json`, so a rerun of the sync recovers.

### Tag shapes

- A clean tag and a prerelease tag run identical macOS packaging; only the Release marking and the R2 sync differ (mac-distribution::US-001, mac-distribution::US-002).
- A `v*` tag with a suffix other than the four listed is treated as a formal release (existing behaviour, unchanged).

### Users installing

- From a formal release or a prerelease: the DMG opens without a Gatekeeper rejection, and the app dragged out of it starts offline because it carries its own ticket. Prereleases no longer need the quarantine attribute removed by hand.

## Implementation Decisions

- Four step scripts share one architecture source (the builder config's macOS DMG target) and locate each built app from the build output by inspecting its binary's architectures, not by guessing directory names; `--x64` and the other architectures write to differently named directories.
- `mac:sign` checks for a certificate source first — a valid Developer ID Application identity in the keychain, or the `CSC_LINK` secret in CI, which the builder imports itself — then builds every architecture's app with the `dir` target and notarization off, and finally asserts each app's signature authority and strict deep verification.
- `mac:notarize-app` submits each app as a zip archive, applies the same Accepted-submission and log checks as the DMG gate, staples the app and validates the staple.
- `mac:dmg` builds each DMG from its app with the prepackaged option, which skips signing and built-in notarization, then checks the DMG's signature content itself, because DMG signing writes no log line.
- `mac:notarize-dmg` is the existing DMG gate, driven by the configured architecture set.
- The CI macOS job chooses the release command for any `v*` tag and for a manual run with the verification switch, and the local command otherwise; a missing certificate secret fails the job in every tier.

## Testing Decisions

- Good tests assert behaviour through an injected command runner: which commands run in which order, what fails and with which message, and that cleanup happens — never that Apple was reached. The unit seam is the build scripts' exported functions, following the existing DMG gate tests, which already use this pattern.
- The workflow and `package.json` are covered by static tests as a regression guard; they do not replace a real run.
- The certificate checks, signature assertions and both entry commands are verified by real runs: `dist:mac:local` with and without an identity, and the release path once (locally with the credentials, or a manual CI run with the verification switch).
- Unit tests that use a fake runner say in the test file that they never contacted Apple.

## Out of Scope

- The Mac App Store line: separate identities and profiles, sandboxed, not notarized (see [ops/mas-submission.md](../ops/mas-submission.md)).
- Windows code signing.
- Changing which tag suffixes count as prereleases.
- A partial release (publishing the architectures that passed when another failed).
- Release notes; their macOS section follows the cross-project release rules.

## Further Notes

- Notarization waits on Apple (minutes to tens of minutes per submission), and every architecture submits twice (app and DMG), so prerelease CI now takes as long as a formal release; ADR-0023 records this trade-off.
