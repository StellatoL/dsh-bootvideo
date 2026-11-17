# Changelog

All notable changes to this bundle are recorded here. Versions follow SemVer and
describe the bundle, not the DSH release it was built against.

## 1.2.0

### Changed

- **Renamed from `dsh-openvideo` to `dsh-bootvideo`**, and the repository moved with it
  (`github.com/StellatoL/dsh-bootvideo`). The repository name now equals the package
  name, which is also the Loader row id, the browser module id and the route prefix.
  Every public identifier follows the rename: the routes are now
  `/dsh-bootvideo/media/` and `/dsh-bootvideo/config`, the injected global is
  `__DSH_BOOTVIDEO__`, and the session marker is `dsh-bootvideo:booted`.
- Upgrading from 1.1.0 needs the old bundle removed first: its row id and routes are
  the old names, so the two identities do not overlap.

## 1.1.0

### Fixed

- **The boot sequence did not run in the Desktop app.** The window serves the shell from
  its own `dsh-app://app/` origin and never runs `webServer.tapIndex` transforms, so the
  injected settings global was missing and the Client half stayed inert. The Host half
  now contributes rows to the carrier-independent `webserver/index-inject` table, which
  both the Web response and the Desktop shell apply.
- The Client half no longer depends on injection at all: it falls back to a new
  `GET /dsh-openvideo/config` route, and under the Desktop origin it fetches the clip
  once and plays it from a blob URL instead of relying on range streaming through the
  shell bridge.

### Changed

- Self-test covers the injection rows, the settings route and the carrier fallbacks
  (102 checks), including a regression guard that the curtain no longer depends on
  `tapIndex`.

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
