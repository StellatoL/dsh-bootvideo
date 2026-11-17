# Changelog

All notable changes to this bundle are recorded here. Versions follow SemVer and
describe the bundle, not the DSH release it was built against.

## 1.0.0

First release.

### Added

- Host half: `Range`/`HEAD`/`If-None-Match` aware media route at
  `/dsh-openvideo/media/`, plus a first-paint curtain injected into `index.html`
  through the Web carrier's index taps.
- Client half: full-frame boot sequence in `shell.overlay` — postered first paint,
  video crossfade, letterbox bars, film grain, vignette, live progress line,
  click/Esc skip, sound toggle, and a graceful exit when the media cannot be played.
- Settings: `enabled`, `playMode` (`always` | `oncePerSession`), `startMuted`,
  `skippable`, `curtain`.
- Media pipeline (`scripts/build-media.mjs`) and the encoded clip, poster frames and
  inline curtain placeholder.
- Self-test (`scripts/selftest.mjs`) covering the route, the index injection and the
  client bundle contract without a running Host.
- Locales: en, zh, ja, de, es, fr, pt, ru.
