// Test support (not bundled: nothing in the app imports it). Builds JPEG byte streams whose metadata
// segments are shaped like real phone photos, for the orientation unit tests and the image-copy e2e test.
//
// Shape taken from four real JPEGs (iPhone photos saved from AirDrop, a Photos-library original, a
// Samsung export), checked 2026-10-22: an APP0 JFIF segment may come before the Exif APP1; a second
// APP1 carries XMP; APP2 (ICC) and other APPn segments follow; the TIFF data is big-endian ("MM");
// IFD0 holds 9–12 entries with Orientation as the third, after Make and Model. None of those samples
// had a non-default orientation, so that value itself is synthetic.

type ByteOrder = 'MM' | 'II'

interface IfdEntry {
  tag: number
  type: number
  count: number
  /** the 4-byte value field; for SHORT values the number goes in its first two bytes */
  value: number
  isShort?: boolean
}

function u16(n: number, order: ByteOrder): number[] {
  return order === 'MM' ? [(n >> 8) & 0xff, n & 0xff] : [n & 0xff, (n >> 8) & 0xff]
}

function u32(n: number, order: ByteOrder): number[] {
  const b = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  return order === 'MM' ? b : b.reverse()
}

function segment(marker: number, payload: number[]): number[] {
  const len = payload.length + 2
  return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload]
}

const ascii = (s: string): number[] => [...Buffer.from(s, 'latin1')]

/** APP0 JFIF, as phones' exports put it before the Exif segment */
export function app0Jfif(): number[] {
  return segment(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0])
}

/**
 * APP1 Exif with IFD0 = the given entries, followed by a small data area that the out-of-line
 * values (ASCII, RATIONAL) point into, as real files do.
 */
export function app1Exif(order: ByteOrder, entries: IfdEntry[], opts: { magic?: number[] } = {}): number[] {
  const tiff: number[] = []
  tiff.push(...(opts.magic ?? ascii(order)), ...u16(42, order), ...u32(8, order))
  tiff.push(...u16(entries.length, order))
  for (const e of entries) {
    tiff.push(...u16(e.tag, order), ...u16(e.type, order), ...u32(e.count, order))
    tiff.push(...(e.isShort ? [...u16(e.value, order), 0, 0] : u32(e.value, order)))
  }
  tiff.push(...u32(0, order)) // no IFD1
  tiff.push(...new Array<number>(64).fill(0)) // data area for out-of-line values
  return segment(0xe1, [...ascii('Exif\0\0'), ...tiff])
}

/** IFD0 laid out like the iPhone samples: 12 entries, Orientation third */
export function phoneIfd0(orientation: number): IfdEntry[] {
  const data = 8 + 2 + 12 * 12 + 4 // offset of the data area inside the TIFF block
  return [
    { tag: 0x010f, type: 2, count: 6, value: data }, // Make
    { tag: 0x0110, type: 2, count: 10, value: data + 8 }, // Model
    { tag: 0x0112, type: 3, count: 1, value: orientation, isShort: true }, // Orientation
    { tag: 0x011a, type: 5, count: 1, value: data + 20 }, // XResolution
    { tag: 0x011b, type: 5, count: 1, value: data + 28 }, // YResolution
    { tag: 0x0128, type: 3, count: 1, value: 2, isShort: true }, // ResolutionUnit
    { tag: 0x0131, type: 2, count: 5, value: data + 36 }, // Software
    { tag: 0x0132, type: 2, count: 20, value: data + 42 }, // DateTime
    { tag: 0x013c, type: 2, count: 1, value: 0 }, // HostComputer (inline)
    { tag: 0x0213, type: 3, count: 1, value: 1, isShort: true }, // YCbCrPositioning
    { tag: 0x8769, type: 4, count: 1, value: data }, // ExifIFD pointer
    { tag: 0x8825, type: 4, count: 1, value: data } // GPS IFD pointer
  ]
}

/** The second APP1 real photos carry: XMP, which also states the orientation */
export function app1Xmp(orientation: number): number[] {
  return segment(0xe1, [
    ...ascii('http://ns.adobe.com/xap/1.0/\0'),
    ...ascii(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><tiff:Orientation>${orientation}</tiff:Orientation></x:xmpmeta>`)
  ])
}

export function app2Icc(): number[] {
  return segment(0xe2, [...ascii('ICC_PROFILE\0'), 1, 1, ...new Array<number>(32).fill(0)])
}

/** The metadata segments of a phone photo with the given orientation, in the real samples' order */
export function phoneMetadata(orientation: number): number[] {
  return [...app0Jfif(), ...app1Exif('MM', phoneIfd0(orientation)), ...app1Xmp(orientation), ...app2Icc()]
}

/** A complete byte stream: SOI, the given segments, then a start-of-scan with a few data bytes and EOI */
export function jpegWith(segments: number[]): Uint8Array {
  const sos = segment(0xda, [1, 1, 0, 0, 0x3f, 0])
  return Uint8Array.from([0xff, 0xd8, ...segments, ...sos, 0x12, 0x34, 0x56, 0xff, 0xd9])
}

/**
 * Puts the given metadata segments into an encoded JPEG right after its SOI, dropping any APP0/APP1
 * the encoder wrote, so the result has exactly the real-sample layout.
 */
export function injectMetadata(jpeg: Uint8Array, segments: number[]): Uint8Array {
  let p = 2
  while (p + 4 <= jpeg.length && jpeg[p] === 0xff && (jpeg[p + 1] === 0xe0 || jpeg[p + 1] === 0xe1)) {
    p += 2 + ((jpeg[p + 2] << 8) | jpeg[p + 3])
  }
  return Uint8Array.from([0xff, 0xd8, ...segments, ...jpeg.subarray(p)])
}
