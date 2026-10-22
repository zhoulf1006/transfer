// Where a context menu opened at the pointer goes so that all of it stays inside the window
// (spec transfer-chat REQ-002): flip to the left of / above the pointer when it would cross the right /
// bottom edge, then clamp to a margin. Pure, so it is unit-tested; the caller measures the menu.

export function placeMenu(
  pointer: { x: number; y: number },
  menu: { width: number; height: number },
  view: { width: number; height: number },
  margin = 4
): { left: number; top: number } {
  let left = pointer.x
  let top = pointer.y
  if (left + menu.width > view.width - margin) left -= menu.width
  if (top + menu.height > view.height - margin) top -= menu.height
  left = Math.max(margin, Math.min(left, view.width - menu.width - margin))
  top = Math.max(margin, Math.min(top, view.height - menu.height - margin))
  return { left, top }
}
