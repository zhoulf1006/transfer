// EXIF orientation for images copied from the chat and for their thumbnails (spec transfer-chat,
// US-001/AC-05 and REQ-001).
//
// Electron's nativeImage decodes JPEG pixels as stored and ignores the EXIF orientation tag, while the
// renderer's <img> (the full-size view) applies it — measured 2026-10-22 on Electron 35: a 200x100 JPEG
// tagged 6 decodes as 200x100 but displays as 100x200. So the main process reads the tag itself and
// turns the decoded bitmap. Pure functions, no Electron import, so they are unit-tested directly.

/** EXIF orientation (tag 0x0112): 1 is "as stored"; 2–8 mirror and/or rotate, see orientBitmap */
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

/**
 * The orientation recorded in a JPEG's Exif APP1 segment, or 1 for anything else: no Exif, no tag,
 * a value outside 1–8, malformed or truncated data, or bytes that are not a JPEG. Never throws.
 * Only Exif is read — an orientation stated only in XMP is ignored (spec boundary group I).
 */
export function readJpegOrientation(bytes: Uint8Array): Orientation {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1
  let p = 2
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) return 1
    const marker = bytes[p + 1]
    if (marker === 0xff) {
      p++ // fill byte before a marker
      continue
    }
    // Metadata segments all come before the image data: stop at start of scan or end of image
    if (marker === 0xda || marker === 0xd9) return 1
    const len = (bytes[p + 2] << 8) | bytes[p + 3]
    if (len < 2) return 1
    const start = p + 4
    const end = Math.min(p + 2 + len, bytes.length)
    if (marker === 0xe1 && isExifHeader(bytes, start, end)) return readTiffOrientation(bytes, start + 6, end)
    p += 2 + len
  }
  return 1
}

function isExifHeader(b: Uint8Array, start: number, end: number): boolean {
  if (end - start < 6) return false
  // "Exif\0\0"
  return (
    b[start] === 0x45 && b[start + 1] === 0x78 && b[start + 2] === 0x69 && b[start + 3] === 0x66 &&
    b[start + 4] === 0 && b[start + 5] === 0
  )
}

/**
 * The bitmap as it should be displayed for the given orientation. `data` is 4 bytes per pixel, rows
 * top to bottom (nativeImage's toBitmap layout; the channel order does not matter, pixels move whole).
 * Orientations 5–8 swap width and height. Returns a new buffer; the source is not modified.
 *
 *   1 as stored          2 mirrored left-right    3 rotated 180°          4 mirrored top-bottom
 *   5 transposed         6 rotated 90° clockwise  7 transversed           8 rotated 90° counter-clockwise
 */
export function orientBitmap(
  data: Uint8Array,
  width: number,
  height: number,
  orientation: Orientation
): { data: Buffer; width: number; height: number } {
  const swap = orientation >= 5
  const w = swap ? height : width
  const h = swap ? width : height
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // The stored pixel that lands at (x, y) of the displayed image
      let sx: number
      let sy: number
      switch (orientation) {
        case 2: sx = width - 1 - x; sy = y; break
        case 3: sx = width - 1 - x; sy = height - 1 - y; break
        case 4: sx = x; sy = height - 1 - y; break
        case 5: sx = y; sy = x; break
        case 6: sx = y; sy = height - 1 - x; break
        case 7: sx = width - 1 - y; sy = height - 1 - x; break
        case 8: sx = width - 1 - y; sy = x; break
        default: sx = x; sy = y
      }
      const from = (sy * width + sx) * 4
      const to = (y * w + x) * 4
      out[to] = data[from]
      out[to + 1] = data[from + 1]
      out[to + 2] = data[from + 2]
      out[to + 3] = data[from + 3]
    }
  }
  return { data: out, width: w, height: h }
}

/** Orientation from the TIFF block that starts at `tiff` and must end before `end` */
function readTiffOrientation(b: Uint8Array, tiff: number, end: number): Orientation {
  if (end - tiff < 8) return 1
  let little: boolean
  if (b[tiff] === 0x49 && b[tiff + 1] === 0x49) little = true // "II"
  else if (b[tiff] === 0x4d && b[tiff + 1] === 0x4d) little = false // "MM"
  else return 1
  const u16 = (o: number): number => (little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1])
  const u32 = (o: number): number =>
    little
      ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
      : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
  if (u16(tiff + 2) !== 42) return 1
  const ifd = tiff + u32(tiff + 4)
  if (ifd + 2 > end) return 1
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12
    if (e + 12 > end) return 1
    if (u16(e) !== 0x0112) continue
    // SHORT, at least one value: the number sits in the first two bytes of the value field
    if (u16(e + 2) !== 3 || u32(e + 4) < 1) return 1
    const v = u16(e + 8)
    return v >= 1 && v <= 8 ? (v as Orientation) : 1
  }
  return 1
}
