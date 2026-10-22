// Demo dimensions (copied from the prototype skill's template; do not edit by hand — change the
// skill template and copy it again). Scaffolding, not part of any design.
//
// A dimension is a product setting whose values the product's source defines as a list, such as the UI
// language or the light/dark mode. Two places set them (the prototype skill's UI.md, harness clause 5):
// the settings prototype, from its own settings controls, sets any of them; the gallery's settings panel
// sets the ones the registry marks `general: true` (the UI language and the light/dark mode). Both write
// the same stored values, so a change made in either shows in the other and on every page that follows
// the dimension. The values are kept in localStorage, so they reach pages already open in another tab,
// in the gallery or restored by Back, and survive reloads. A page that does not follow a dimension always
// sees that dimension's default.
//
// The project registers its dimensions in dimensions.js beside this file (window.DEMO_DIMENSIONS); a page
// includes both in <head>, before any script of its own, and names the dimensions it follows:
//   <script src="../dimensions.js"></script>
//   <script src="../demo-dimensions.js" data-follow="language=zh,en mode theme"></script>
// "language=zh,en" follows the language but says the page is drawn in those two values only: any other
// value shows as the dimension's fallback (its registry `fallback`, else its default), and a note on the
// page says so. The two places that set values include the script with data-settings instead: they follow
// every registered dimension, in all its values, and only they may call set.
//
// A followed dimension's value in effect is also set on the root element as data-demo-<id>, before the
// page renders and on every change, so styles can select on it: html[data-demo-mode="dark"] { ... }
//
//   DemoDimensions.on(id, fn)          calls fn(value) now, and again whenever the value in effect changes,
//                                      whichever page changed it
//   DemoDimensions.get(id)             the value in effect on this page
//   DemoDimensions.set(values, state)  data-settings pages only: the values in effect ({ id: value }), and
//                                      the settings prototype's own state they were derived from; the
//                                      gallery leaves state out, which keeps the stored state as it was,
//                                      and set({}, state) saves the state alone
//   DemoDimensions.state()             the state last passed to set, or null; the settings prototype
//                                      restores itself from it, so it reopens as the reader left it
window.DemoDimensions = (() => {
  const DIMS = window.DEMO_DIMENSIONS || {}
  const KEY = 'proto-demo-dimensions'
  const settings = document.currentScript?.hasAttribute('data-settings') ?? false

  function dim(id) {
    if (!DIMS[id]) throw new Error(`demo-dimensions: "${id}" is not registered in dimensions.js`)
    return DIMS[id]
  }
  // { id: the values this page is drawn in }
  const drawn = {}
  if (settings) for (const id of Object.keys(DIMS)) drawn[id] = DIMS[id].values
  for (const token of (document.currentScript?.dataset.follow || '').split(/\s+/).filter(Boolean)) {
    const [id, only] = token.split('=')
    drawn[id] = only ? only.split(',') : dim(id).values
    for (const v of drawn[id]) if (!dim(id).values.includes(v)) throw new Error(`demo-dimensions: "${v}" is not a value of "${id}"`)
  }
  const fallback = (id) => dim(id).fallback ?? dim(id).default

  let stored = {}
  function load() { try { stored = JSON.parse(localStorage.getItem(KEY) || '{}') || {} } catch { stored = {} } }
  load()

  // What the reader chose, which the page may not be drawn in
  function chosen(id) {
    const v = stored.values?.[id]
    return drawn[id] && dim(id).values.includes(v) ? v : dim(id).default
  }
  function get(id) {
    const v = chosen(id)
    return !drawn[id] || drawn[id].includes(v) ? v : fallback(id)
  }

  function reflect() {
    for (const id of Object.keys(drawn)) document.documentElement.setAttribute(`data-demo-${id}`, get(id))
    if (document.body) note()
  }

  // The visible note for a value the page is not drawn in (UI.md, harness clause 5)
  let noteEl = null
  function note() {
    const lines = Object.keys(drawn).filter((id) => get(id) !== chosen(id)).map((id) =>
      (window.DEMO_DIMENSIONS_FALLBACK_NOTE || 'Not drawn in {label} {chosen}; showing {shown}')
        .replace('{label}', dim(id).label || id).replace('{chosen}', chosen(id).toUpperCase())
        .replace('{shown}', get(id).toUpperCase()))
    if (lines.length === 0) { noteEl?.remove(); noteEl = null; return }
    if (!noteEl) {
      noteEl = document.createElement('div')
      // Marked as demo scaffolding; appended last, so a page's own harness stays the first one in the document
      noteEl.setAttribute('data-demo-harness', '')
      noteEl.setAttribute('role', 'status')
      // all:initial first: older pages style their own harness through [data-demo-harness] (centred, pinned
      // to the bottom) instead of leaving its look to demo-harness.js, and without it those rules would land
      // on the note too and stretch it across the page
      noteEl.style.cssText = 'all:initial;display:block;position:fixed;top:10px;right:12px;z-index:2147483000;' +
        'padding:5px 11px;border-radius:999px;background:#1c1c1e;color:#e8e8ea;white-space:nowrap;' +
        'font:600 11.5px/1.4 -apple-system,system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3);pointer-events:none'
    }
    noteEl.textContent = lines.join(' · ')
    if (!noteEl.isConnected) document.body.appendChild(noteEl)
  }
  reflect()
  document.addEventListener('DOMContentLoaded', note)

  const listeners = {}
  const last = {}
  function on(id, fn) {
    ;(listeners[id] ||= []).push(fn)
    last[id] = get(id)
    fn(last[id])
  }
  // Only a real change of the value in effect reaches the listeners
  function notify() {
    reflect()
    for (const id of Object.keys(listeners)) {
      const v = get(id)
      if (v === last[id]) continue
      last[id] = v
      for (const fn of listeners[id]) fn(v)
    }
  }

  function set(values, state) {
    if (!settings) throw new Error('demo-dimensions: only a page that includes this script with data-settings may set values')
    for (const [id, v] of Object.entries(values)) {
      if (!dim(id).values.includes(v)) throw new Error(`demo-dimensions: "${v}" is not a value of "${id}"`)
    }
    stored = { values: { ...stored.values, ...values }, state: state === undefined ? stored.state : state }
    try { localStorage.setItem(KEY, JSON.stringify(stored)) } catch {}
    notify()
  }
  const state = () => stored.state ?? null

  // A page that is already open read the stored values once, so a change made on another page (the settings
  // prototype, or the gallery around this page) reaches it through the storage event; a page restored by
  // Back missed those events while it was cached
  function reload() { load(); notify() }
  window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) reload() })
  window.addEventListener('pageshow', (e) => { if (e.persisted) reload() })

  return { on, get, set, state }
})()
