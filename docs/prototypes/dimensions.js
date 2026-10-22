// Demo dimension registry: the product settings that switch the whole interface's presentation.
// Read by demo-dimensions.js; set from the gallery's settings panel (both dimensions are general).
// This is the prototypes' own baseline, not generated from the product source.
//
// language: the settings prototype preselects 中文, so the default is zh; the product falls back to en
//   when the system language is neither, so the fallback is en.
// mode: no settings prototype selects it, so the default is the first value.
window.DEMO_DIMENSIONS = {
  language: { label: 'Language', values: ['zh', 'en'], default: 'zh', fallback: 'en', general: true },
  mode: { label: 'Mode', values: ['light', 'dark'], default: 'light', general: true }
}
