import { describe, test, expect } from 'vitest'
import { placeMenu } from './menu-placement'

// Window 900x640 (the app's default size), menu 160x104, margin 4: the menu may reach x 896 and y 636.
// Every expected position below is worked out by hand from the rule in spec transfer-chat REQ-002.
const view = { width: 900, height: 640 }
const size = { width: 160, height: 104 }

describe('placeMenu', () => {
  test('opens at the pointer when there is room', () => {
    expect(placeMenu({ x: 100, y: 100 }, size, view)).toEqual({ left: 100, top: 100 })
  })

  test('opens to the left of the pointer when it would cross the right edge', () => {
    expect(placeMenu({ x: 800, y: 100 }, size, view)).toEqual({ left: 640, top: 100 })
  })

  test('opens above the pointer when it would cross the bottom edge', () => {
    expect(placeMenu({ x: 100, y: 600 }, size, view)).toEqual({ left: 100, top: 496 })
  })

  test('flips both ways in the bottom-right corner', () => {
    expect(placeMenu({ x: 850, y: 600 }, size, view)).toEqual({ left: 690, top: 496 })
  })

  test('does not flip when the menu ends exactly at the margin, and flips one pixel later', () => {
    expect(placeMenu({ x: 736, y: 532 }, size, view)).toEqual({ left: 736, top: 532 })
    expect(placeMenu({ x: 737, y: 533 }, size, view)).toEqual({ left: 577, top: 429 })
  })

  test('keeps the margin when flipping would pass the left or top edge', () => {
    const narrow = { width: 300, height: 200 }
    // 150+160 > 296 flips to -10; 100+104 > 196 flips to -4: both clamp to the margin
    expect(placeMenu({ x: 150, y: 100 }, size, narrow)).toEqual({ left: 4, top: 4 })
  })

  test('keeps the margin when the pointer is inside it', () => {
    expect(placeMenu({ x: 1, y: 2 }, size, view)).toEqual({ left: 4, top: 4 })
  })
})
