import { describe, test, expect } from 'vitest'
import { orientBitmap, readJpegOrientation, type Orientation } from './image-orientation'
import {
  app0Jfif,
  app1Exif,
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

  test('is the default for a file cut off inside IFD0, without throwing', () => {
    const whole = jpegWith(phoneMetadata(6))
    // APP0 (18 bytes) + APP1 header (4) + "Exif\0\0" (6) + TIFF header (8) + count (2) + two entries
    const cut = whole.subarray(0, 2 + 18 + 4 + 6 + 8 + 2 + 24)
    expect(readJpegOrientation(cut)).toBe(1)
  })

  test('is the default when the IFD0 offset points past the segment', () => {
    const exif = app1Exif('MM', phoneIfd0(6))
    // TIFF header starts after FF E1, length (2) and "Exif\0\0" (6); its IFD0 offset is bytes 4..7
    const tiff = 2 + 2 + 6
    exif.splice(tiff + 4, 4, 0x00, 0x00, 0xff, 0xf0)
    expect(readJpegOrientation(jpegWith(exif))).toBe(1)
  })

  test('is the default when the TIFF byte-order mark is not MM or II', () => {
    const exif = app1Exif('MM', phoneIfd0(6), { magic: [0x58, 0x58] })
    expect(readJpegOrientation(jpegWith(exif))).toBe(1)
  })

  test('is the default for bytes that are not a JPEG (a PNG signature)', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])
    expect(readJpegOrientation(png)).toBe(1)
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
