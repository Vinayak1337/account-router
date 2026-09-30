# Design

A compact account workspace. One aligned priority list puts account identity, remaining usage and routing controls on the same row. Selected accounts have a quiet blue edge. Current routing sits above the list; settings and activity stay below it. No decorative background or marketing sections.

Details expand across their account row. Short, labelled facts sit beside a saved-reset panel, with full timestamps in tooltips and confirmation before a manual reset. At narrower widths the same controls move below identity; details stack without horizontal scrolling. Dark and light themes use system typography, tabular numbers and the existing SVG icon family.

The frontend retains its vanilla modules and keyed DOM reconciliation. Status ticks preserve scroll, focus, account picker choice and expanded disclosures. Priority supports dragging and keyboard-accessible arrows. Dialog and meter motion respects reduced-motion preferences. Selection, recurring, Drain and model-routing behavior remain in their existing modules.

## Guidance

- [Adam Holter's frontend skill](https://github.com/adamholter/frontend-skill/blob/5b2cf1ed3f28e0013a0626ddc83313ca552565fa/SKILL.md), pinned at `5b2cf1e`: product-led layout, minimal copy, existing primitives, restrained surfaces and real interaction checks. Discovered through [his frontend tests](https://adam.holter.com/tests/).
- Earlier design guidance: [Appllama App Design](https://github.com/Appllama/appllama-skills/tree/dd5caaec3d5d50ad7fc0324da238119c6b7c3707/skills/appllama-app-design-skill), v1.3.0, MIT, and [Taste Skill](https://github.com/Leonxlnx/taste-skill/tree/ce26fc25c0e5e8cab638f883de62d9a86ee5e45b/skills).

Artwork and icons are original SVG geometry. Published screenshots contain only synthetic preview accounts.

## Preview without restarting

`npm run preview:live` serves source dashboard files on loopback port 18893 against the installed router on 18891. It reads no account files, starts no router and forwards only allowlisted dashboard operations. The existing router owns authentication. Host, origin, action headers and request size are checked before forwarding; inference and arbitrary destinations are unavailable. This development helper is excluded from the Windows package.

## Windows icon

The routing mark is shared by the dashboard, window, installer and shortcuts. The ICO includes ten sizes from 16 to 256 pixels; the tray uses a dedicated 32-pixel PNG. Regenerate with `python dev/build-icon.py` (Pillow required). Windows has an explicit application identity for taskbar grouping.
