# Design

A compact desktop utility: top navigation, one current-account panel, two-column priority cards, and account details on demand. Neutral surfaces, one blue accent, system typography, tabular numbers, and one SVG icon family. Dark mode is the default; light mode persists locally.

The dashboard reconciles keyed DOM nodes. Background updates preserve scroll, focus, native select choice, and expanded details. Motion uses transform/opacity and respects reduced-motion preferences.

Guidance adapted from:

- [Appllama App Design](https://github.com/Appllama/appllama-skills/tree/dd5caaec3d5d50ad7fc0324da238119c6b7c3707/skills/appllama-app-design-skill), v1.3.0, MIT: semantic themes, native control conventions, purposeful motion, full state cycles.
- [Taste Skill](https://www.tasteskill.dev/docs), [pinned source](https://github.com/Leonxlnx/taste-skill/tree/ce26fc25c0e5e8cab638f883de62d9a86ee5e45b/skills): redesign audit, minimalist surfaces, spacing, and interaction feedback. Marketing hero and scroll-pinning prescriptions were omitted for this utility.

Artwork and icons are original SVG geometry. The README screenshot contains synthetic preview accounts, not user accounts.

## Drain controls

Three compact account actions: select, recurring, Drain. Drain is a persistent, per-account toggle; armed is distinct from active. A temporary fallback banner names the account being reset and explains the return. Waiting, resetting, paused and depleted states are visible on the card; full recovery guidance lives in Details. Account email is available in Details and the identity tooltip. Updates preserve card nodes, expanded details, keyboard focus and viewport. Motion respects reduced-motion preferences.

## Account details

A dedicated Details component renders compact definition rows with aligned values, short dates with exact timestamps in tooltips, a distinct saved-reset panel, and one quiet freshness line. Native disclosure state and existing confirmation flows are preserved. The panel adapts to the minimum desktop width in both themes.

## Windows icon

Original routing mark shared by the dashboard, app window, installer and shortcuts. The ICO includes ten sizes from 16 to 256 pixels; the tray uses a dedicated 32-pixel PNG. Regenerate assets with `python dev/build-icon.py` (Pillow required). Windows uses an explicit application identity for taskbar grouping.
