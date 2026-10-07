# Accessibility, localization and browser limits

The target is WCAG 2.2 AA. Automated checks support that target but do not establish a complete
conformance claim. [Verification](verification.md) separates automated coverage from observations
that require people and physical devices.

## Interaction

Core workflows offer keyboard, mouse and trackpad paths. Dragging is an enhancement with button
alternatives. Dialogs need labeled controls, logical focus, trapping/restoration and visible errors.
State and conflicts use text as well as color. The Alignment relationship list offers the map's
operations without relying on spatial graphics.

Light, dark and system themes are supported. Reduced motion uses static feedback. Week switches to
agenda/day-card presentation at narrower sizes or greater text zoom. Dense Day/Today lists use
bounded pages and timeline alternatives rather than unreadable columns or silent truncation.

When reporting an accessibility problem, include the browser/OS, reader and version, input method,
theme, viewport, text/browser zoom, steps and actual spoken or visual result. Use synthetic content.
[Contributing](../CONTRIBUTING.md) and [testing](development.md#testing) describe the checks for UI
changes.

## Localization

English is the shipped interface language, with ordinary UI rendered left to right. Dates and
numbers use device-aware native `Intl` formatting; English messages use English plural categories.
The planning time zone, first weekday and time format are explicit planning preferences that can be
confirmed without personal profile data. A stored display-locale field does not provide a complete
translated interface.

`packages/i18n` owns message IDs and catalogs, placeholder validation, locale normalization,
direction helpers and expanded left-to-right/right-to-left pseudo-locales. Pseudo-locales and
longer-text fixtures exercise layout; they are test content, not supported translations or a shipped
arbitrary-language interface. Add a locale through a complete reviewed catalog, preserve
placeholders and check all core routes in both themes and directions. Use logical CSS edges; do not
infer planning dates from translated strings.

## Browser and performance limits

Chromium desktop targets website and browser-native PWA use. Firefox desktop targets the website.
Safari and native mobile clients are not verified supported targets. Secure contexts, Web Locks,
IndexedDB, workers, WebAssembly and native compression are needed for the persistence/runtime path.
Private browsing or restrictive policy can prevent storage or installation.

One active tab owns each plan. Browser storage is best effort and unencrypted. Notifications require
permission and open-app delivery; browser closure, background throttling, OS suspension and
lock-screen settings limit delivery.

Writes save a complete SQLite image, so database size affects cost. Large synthetic plans and dense
views have automated benchmarks, but budgets are environment-specific rather than universal device
promises. Firefox does not expose all Chrome heap/LongTasks measurements; process RSS is a separate
measure. Visible build chunk warnings may remain even when measured interaction budgets pass.
