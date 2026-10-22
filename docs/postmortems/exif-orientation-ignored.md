# Phone photos showed sideways in chat thumbnails

2026-10-22. Found while adding Copy Image to the image menu (spec transfer-chat, REQ-001).

## Symptom

A portrait photo taken on a phone and sent as a JPEG showed **sideways** in its chat thumbnail, while clicking it opened the full-size view **upright**. Copying it the obvious way (decode in the main process, write to the clipboard) would have pasted it sideways too.

## Root cause

Phone cameras usually store the pixels in the sensor's landscape order and record the intended rotation in the EXIF orientation tag (0x0112). The two decoders in the app disagree about that tag:

| Decoder | Used for | Applies the tag? |
|---|---|---|
| `nativeImage` (main process) | thumbnail, and now copy | **No** — decodes the pixels as stored |
| Chromium `<img>` (renderer) | full-size view | Yes (CSS `image-orientation: from-image` is the default) |

Measured on Electron 35.7.5, macOS: a 200×100 JPEG tagged 6 decodes to 200×100 with `nativeImage.createFromPath` and `createFromBuffer`, and loads as 100×200 in `<img>`.

## Why nothing caught it

- Every test and fixture image had no orientation tag, and screenshots — the commonest images in this app — never carry one.
- Nothing compared the thumbnail with the full-size view: each was correct by its own decoder.

## Fix and defences

- The main process reads the tag itself and turns the decoded bitmap (`src/main/image-orientation.ts`), for both the copy and the thumbnail; a quarter-turned thumbnail is fitted by the stored height so it keeps the usual width.
- e2e `image-copy.spec.ts` copies and thumbnails a JPEG whose metadata is shaped like a real phone photo's, tagged 6, with an asymmetric mark so orientations 5 and 6 can't be confused.
- CONTEXT.md invariant: every main-process path that shows or copies an image must apply the tag.

## How to measure it again

- Make a test image: encode a non-square bitmap with `nativeImage.toJPEG`, then insert an APP1 Exif segment right after SOI with IFD0 holding one entry, tag 0x0112 SHORT = 6 (the builder in `src/main/image-orientation.fixture.ts` does this, shaped like real phone files).
- Compare `nativeImage.createFromBuffer(bytes).getSize()` with an `<img>`'s `naturalWidth/naturalHeight` in a hidden `BrowserWindow`.

## Dead end

- **`sips -g orientation` reports `<nil>`**, both for a valid hand-made tag and for real iPhone photos — don't use it to decide whether a file carries an orientation. Chromium's `<img>` (or parsing the Exif segment) is the reliable check.
