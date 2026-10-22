# Playwright's dispatchEvent('contextmenu') carries no pointer position

2026-10-22. Found while writing the image-menu e2e tests (`e2e/image-copy.spec.ts`).

## Symptom

`locator.dispatchEvent('contextmenu', { clientX, clientY, button: 2 })` opened the image menu, and the tests asserting its items and the copy passed — but the menu sat at the window's top-left whatever position was passed. Only the edge-placement test, the first one to look at where the menu was, failed: the menu's left edge was 0 where it had to be at least 4.

## Root cause

Playwright builds the event from its type name, and for `contextmenu` it creates a plain `Event`, not a `MouseEvent`, so `clientX`/`clientY` are not set at all (probe: `["Event", null, null]`). The menu's position became `undefined`/`NaN`, which the style dropped.

## Why nothing caught it

Every assertion except the placement one was independent of where the menu was, so a menu opened at no position passed them all. The hidden test window takes no real pointer input (`page.mouse` / `click()` don't reach it — see `e2e/ui-icons.spec.ts`), which is why dispatched events are used in the first place.

## Fix and defence

- Build the event in the page: `el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX, clientY }))` (helper `rightClick` in `e2e/image-copy.spec.ts`).
- Pass whole pixels: `MouseEvent.clientX/Y` come back as integers, so a fractional box position (249.5) reads back as 249.
- Any test that dispatches a positional mouse event should assert something that depends on the position, or it can't tell this failure from success.
