import { describe, test, expect } from 'vitest'
import { orientBitmap, readJpegOrientation, thumbnailFit, type Orientation } from './image-orientation'
import {
  app0Jfif,
  app1Exif,
  app1Xmp,
  app2Icc,
  jpegWith,
  phoneIfd0,
  phoneMetadata
} from './image-orientation.fixture'

// Expected values are the orientation numbers written into each fixture (EXIF 2.3, tag 0x0112);
// 1 is the default the spec prescribes for anything absent, unrecognised or unreadable.
describe('readJpegOrientation', () => {
  test('reads the orientation from a header laid out like a phone photo', () => {
    expect(readJpegOrientation(jpegWith(phoneMetadata(6)))).toBe(6)
  })

  test('reads little-endian (Intel) TIFF data', () => {
    const entries = [
      { tag: 0x010f, type: 2, count: 8, value: 70 },
      { tag: 0x0110, type: 2, count: 8, value: 78 },
      { tag: 0x0112, type: 3, count: 1, value: 8, isShort: true },
      { tag: 0x8769, type: 4, count: 1, value: 70 }
    ]
    expect(readJpegOrientation(jpegWith(app1Exif('II', entries)))).toBe(8)
  })

  test.each([2, 3, 4, 5, 7])('reads the non-default value %i', (value) => {
    expect(readJpegOrientation(jpegWith(phoneMetadata(value)))).toBe(value)
  })

  test('is the default when there is no Exif segment', () => {
    expect(readJpegOrientation(jpegWith([...app0Jfif(), ...app2Icc()]))).toBe(1)
  })

  test.each([0, 9])('treats the unrecognised value %i as the default', (value) => {
    expect(readJpegOrientation(jpegWith(phoneMetadata(value)))).toBe(1)
  })

  test('is the default when IFD0 has no orientation entry', () => {
    const withoutOrientation = phoneIfd0(6).filter((e) => e.tag !== 0x0112)
    expect(readJpegOrientation(jpegWith(app1Exif('MM', withoutOrientation)))).toBe(1)
  })

  // The two cases below each plant a readable orientation 6 just past the limit being tested, so a
  // reader that skips that bounds check returns 6 instead of throwing — the check itself is what they test.
  test('is the default when the file ends inside the orientation value', () => {
    const exif = app1Exif('II', [{ tag: 0x0112, type: 3, count: 1, value: 6, isShort: true }])
    // SOI (2) + APP1 marker and length (4) + "Exif\0\0" (6) = TIFF start 12; IFD0 at TIFF+8 holds the
    // count (2), then the entry: tag, type, count (8 bytes), then the value's low byte at TIFF+18
    const cut = jpegWith(exif).subarray(0, 12 + 18 + 1)
    expect(cut[cut.length - 1], 'the cut keeps the low byte of the value').toBe(6)
    expect(readJpegOrientation(cut)).toBe(1)
  })

  test('is the default when IFD0 lies past the end of the Exif segment', () => {
    const exif = app1Exif('MM', [])
    // an orientation-6 IFD in the next segment's payload: count 1, then tag 0x0112 SHORT 1 = 6
    const planted = [0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]
    const app2 = [0xff, 0xe2, 0, planted.length + 2, ...planted]
    const tiffStart = 2 + 4 + 6
    const plantedAt = 2 + exif.length + 4
    const offset = plantedAt - tiffStart
    exif.splice(10 + 4, 4, (offset >>> 24) & 0xff, (offset >>> 16) & 0xff, (offset >>> 8) & 0xff, offset & 0xff)
    expect(readJpegOrientation(jpegWith([...exif, ...app2]))).toBe(1)
  })

  test('is the default when the TIFF byte-order mark is not MM or II', () => {
    const exif = app1Exif('MM', phoneIfd0(6), { magic: [0x58, 0x58] })
    expect(readJpegOrientation(jpegWith(exif))).toBe(1)
  })

  test('ignores an orientation stored outside a JPEG Exif segment: a PNG eXIf chunk', () => {
    const tiff = app1Exif('MM', phoneIfd0(6)).slice(10) // the TIFF block alone, as eXIf holds it
    const chunk = (type: string, data: number[]): number[] => [
      (data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff,
      ...Buffer.from(type, 'latin1'), ...data, 0, 0, 0, 0
    ]
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
      ...chunk('eXIf', tiff),
      ...chunk('IEND', [])
    ])
    expect(readJpegOrientation(png)).toBe(1)
  })

  test('ignores an orientation stated only in XMP', () => {
    expect(readJpegOrientation(jpegWith([...app0Jfif(), ...app1Xmp(6)]))).toBe(1)
  })
})

// A 3x2 bitmap whose pixels are named a..f:
//   a b c
//   d e f
// Each expected grid below is written by hand from the EXIF 2.3 orientation table (what the stored
// rows and columns become when displayed), not computed by any code.
describe('orientBitmap', () => {
  const NAMES = 'abcdef'
  // 4 distinct bytes per pixel, so a mix-up of channels or of pixel stride shows as a wrong name
  const pixel = (name: string): number[] => {
    const k = NAMES.indexOf(name)
    return [10 * k + 1, 10 * k + 2, 10 * k + 3, 10 * k + 4]
  }
  const source = Buffer.from([...'abcdef'].flatMap(pixel))
  const names = (data: Buffer): string =>
    Array.from({ length: data.length / 4 }, (_, i) => NAMES[(data[i * 4] - 1) / 10]).join('')

  const cases: Array<[Orientation, string, number, number, string]> = [
    [1, 'as stored', 3, 2, 'abc' + 'def'],
    [2, 'mirrored left-right', 3, 2, 'cba' + 'fed'],
    [3, 'rotated 180°', 3, 2, 'fed' + 'cba'],
    [4, 'mirrored top-bottom', 3, 2, 'def' + 'abc'],
    [5, 'transposed', 2, 3, 'ad' + 'be' + 'cf'],
    [6, 'rotated 90° clockwise', 2, 3, 'da' + 'eb' + 'fc'],
    [7, 'transversed', 2, 3, 'fc' + 'eb' + 'da'],
    [8, 'rotated 90° counter-clockwise', 2, 3, 'cf' + 'be' + 'ad']
  ]

  test.each(cases)('orientation %i shows the bitmap %s', (orientation, _label, width, height, grid) => {
    const out = orientBitmap(source, 3, 2, orientation)
    expect([out.width, out.height]).toEqual([width, height])
    expect(names(out.data)).toBe(grid)
    // every channel of every pixel moved with its pixel
    expect([...out.data]).toEqual([...grid].flatMap(pixel))
  })

  test('leaves the source bitmap untouched', () => {
    const before = Buffer.from(source)
    orientBitmap(source, 3, 2, 6)
    expect(source.equals(before)).toBe(true)
  })
})

describe('thumbnailFit', () => {
  // A stored image is fitted so that it is the given width once displayed: orientations 5–8 turn it a
  // quarter, so its stored height becomes the displayed width (EXIF 2.3 orientation table)
  test.each([
    [1, { width: 180 }],
    [2, { width: 180 }],
    [3, { width: 180 }],
    [4, { width: 180 }],
    [5, { height: 180 }],
    [6, { height: 180 }],
    [7, { height: 180 }],
    [8, { height: 180 }]
  ] as Array<[Orientation, object]>)('orientation %i fits the stored image by %o', (orientation, fit) => {
    expect(thumbnailFit(orientation, 180)).toEqual(fit)
  })
})
