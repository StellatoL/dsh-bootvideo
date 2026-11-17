/**
 * dsh-bootvideo — Client half.
 *
 * A full-frame boot sequence rendered into `shell.overlay`:
 *
 *   head-injected curtain (index.js)  ->  blurred first paint, lifts on our signal
 *   this overlay                     ->  sharp poster -> video -> letterbox chrome
 *   hand-off                         ->  bars retract, overlay blurs and fades out
 *
 * The overlay is deliberately self-contained: it writes no DOM outside its own
 * React tree, renders its own `<style>` (so unmounting removes it), reads the
 * user's DSH language from `ctx.locale`, and never renders twice per page.
 *
 * `shell.overlay` is a click-through layer, so the root opts back into pointer
 * events to own the frame while it is up.
 */

window.__ModuleLoader__.load({
  id: 'dsh-bootvideo',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const STRINGS = {
      en: { tagline: 'Preparing your workspace', skip: 'Skip', soundOn: 'Turn sound on', soundOff: 'Turn sound off' },
      zh: { tagline: '正在准备工作区', skip: '跳过', soundOn: '开启声音', soundOff: '关闭声音' },
      ja: { tagline: 'ワークスペースを準備しています', skip: 'スキップ', soundOn: 'サウンドをオン', soundOff: 'サウンドをオフ' },
      de: { tagline: 'Arbeitsbereich wird vorbereitet', skip: 'Überspringen', soundOn: 'Ton einschalten', soundOff: 'Ton ausschalten' },
      es: { tagline: 'Preparando tu espacio de trabajo', skip: 'Omitir', soundOn: 'Activar sonido', soundOff: 'Silenciar' },
      fr: { tagline: 'Préparation de votre espace de travail', skip: 'Passer', soundOn: 'Activer le son', soundOff: 'Couper le son' },
      pt: { tagline: 'Preparando seu espaço de trabalho', skip: 'Pular', soundOn: 'Ativar som', soundOff: 'Desativar som' },
      ru: { tagline: 'Подготовка рабочего пространства', skip: 'Пропустить', soundOn: 'Включить звук', soundOff: 'Выключить звук' },
    }

    const reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // ------------------------------------------------------------- settings

    /** Coerce one settings object (injected global or config route) into shape. */
    function normalizeSettings (raw) {
      if (!raw || typeof raw !== 'object') return null
      const mediaBase = typeof raw.mediaBase === 'string' && raw.mediaBase
        ? raw.mediaBase
        : '/dsh-bootvideo/media/'
      return {
        enabled: raw.enabled !== false,
        playMode: raw.playMode === 'oncePerSession' ? 'oncePerSession' : 'always',
        startMuted: raw.startMuted !== false,
        skippable: raw.skippable !== false,
        mediaBase,
        readyEvent: typeof raw.readyEvent === 'string' ? raw.readyEvent : 'dsh-bootvideo:ready',
        storageKey: typeof raw.storageKey === 'string' ? raw.storageKey : 'dsh-bootvideo:booted',
      }
    }

    /** Settings the shell injected as an index row, when this carrier applies them. */
    function readSettings () {
      return normalizeSettings(window.__DSH_BOOTVIDEO__)
    }

    /**
     * Carrier-independent settings fallback. A carrier that renders its own
     * document (the Desktop `dsh-app://app/` window) applies the injection rows
     * but a carrier that applies neither still has the Host's route.
     */
    async function fetchSettings () {
      if (typeof fetch !== 'function') return null
      try {
        const response = await fetch('/dsh-bootvideo/config', { headers: { accept: 'application/json' } })
        if (!response.ok) return null
        return normalizeSettings(await response.json())
      } catch {
        return null
      }
    }

    /** True for the Desktop renderer's custom `dsh-app://app/` origin. */
    function isShellOrigin () {
      try {
        return typeof location !== 'undefined'
          && location.protocol !== 'http:'
          && location.protocol !== 'https:'
      } catch {
        return false
      }
    }

    function directSources (base) {
      return [
        { key: 'webm', src: `${base}boot.webm`, type: 'video/webm' },
        { key: 'mp4', src: `${base}boot.mp4`, type: 'video/mp4' },
      ]
    }

    /**
     * Resolve playable `<source>` entries. Under the Desktop origin media is
     * relayed through the shell bridge; a blob URL built from one plain fetch is
     * more predictable there than asking that bridge for byte ranges. Everywhere
     * else the element streams the files directly.
     */
    async function resolveSources (base) {
      if (!isShellOrigin() || typeof fetch !== 'function' || typeof URL.createObjectURL !== 'function') {
        return directSources(base)
      }
      try {
        const response = await fetch(`${base}boot.webm`)
        if (!response.ok) return directSources(base)
        const blob = await response.blob()
        if (!blob.size) return directSources(base)
        return [{ key: 'webm', src: URL.createObjectURL(blob), type: blob.type || 'video/webm' }]
      } catch {
        return directSources(base)
      }
    }

    function hasBooted (settings) {
      if (settings.playMode !== 'oncePerSession') return false
      try {
        return sessionStorage.getItem(settings.storageKey) === '1'
      } catch {
        return false
      }
    }

    function pickLanguage (ctx) {
      try {
        const snapshot = ctx.locale && ctx.locale.getLocale ? ctx.locale.getLocale() : null
        const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : ''
        if (active) return active.slice(0, 2).toLowerCase()
      } catch {
        /* fall through to the browser language */
      }
      const nav = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en'
      return nav.slice(0, 2).toLowerCase()
    }

    // -------------------------------------------------------------- overlay

    const CSS = `
.dsh-ov{position:fixed;inset:0;z-index:2147483000;overflow:hidden;background:#070608;
  pointer-events:auto;contain:strict;--dsh-ov-bar:8.5vh;outline:none;
  -webkit-user-select:none;user-select:none;
  opacity:0;animation:dsh-ov-in .42s ease-out forwards}
.dsh-ov.is-leaving{animation:dsh-ov-out .66s cubic-bezier(.4,0,.2,1) forwards}
@keyframes dsh-ov-in{from{opacity:0}to{opacity:1}}
@keyframes dsh-ov-out{
  0%{opacity:1;filter:blur(0) saturate(1);transform:scale(1)}
  60%{opacity:.55}
  100%{opacity:0;filter:blur(9px) saturate(1.1);transform:scale(1.04)}}

.dsh-ov-stage{position:absolute;inset:0;overflow:hidden;background:#0b090c}
/* One animated wrapper holds the poster AND the video, so the push-in and the
   colour grade stay identical across the crossfade instead of drifting apart. */
.dsh-ov-media{position:absolute;inset:-2%;transform:translate3d(0,0,0) scale(1.035);
  will-change:transform;filter:saturate(1.07) contrast(1.06) brightness(1.16);
  animation:dsh-ov-push var(--dsh-ov-push,13s) linear both}
@keyframes dsh-ov-push{
  from{transform:translate3d(0,0,0) scale(1.035)}
  to{transform:translate3d(-.7%,-.35%,0) scale(1.085)}}
.dsh-ov-poster{position:absolute;inset:0;background-position:center;background-size:cover}
.dsh-ov-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;
  opacity:0;transition:opacity .62s ease-out}

.dsh-ov-vignette{position:absolute;inset:0;pointer-events:none;
  background:
    radial-gradient(118% 96% at 50% 44%,rgba(0,0,0,0) 40%,rgba(0,0,0,.62) 100%),
    linear-gradient(180deg,rgba(0,0,0,.6) 0%,rgba(0,0,0,0) 24%,rgba(0,0,0,0) 60%,rgba(0,0,0,.82) 100%)}
.dsh-ov-grain{position:absolute;inset:0;pointer-events:none;opacity:.05;mix-blend-mode:overlay;
  background-size:170px 170px;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
  animation:dsh-ov-grain 1.1s steps(3) infinite}
@keyframes dsh-ov-grain{
  0%{background-position:0 0}33%{background-position:-24px 12px}
  66%{background-position:18px -14px}100%{background-position:0 0}}

.dsh-ov-bar{position:absolute;left:0;right:0;height:0;background:#000;z-index:2;
  transition:height .85s cubic-bezier(.22,1,.36,1)}
.dsh-ov-bar--top{top:0}
.dsh-ov-bar--bottom{bottom:0}
.dsh-ov.is-armed .dsh-ov-bar{height:var(--dsh-ov-bar)}
.dsh-ov.is-leaving .dsh-ov-bar{height:0;transition-duration:.36s}

.dsh-ov-chrome{position:absolute;left:0;right:0;bottom:0;z-index:3;
  height:var(--dsh-ov-bar);min-height:54px;padding:0 30px;
  display:flex;align-items:center;justify-content:space-between;gap:22px;
  opacity:0;transform:translateY(9px);
  transition:opacity .8s ease-out .18s,transform .8s cubic-bezier(.22,1,.36,1) .18s}
.dsh-ov.is-armed .dsh-ov-chrome{opacity:1;transform:none}
.dsh-ov.is-leaving .dsh-ov-chrome{opacity:0;transform:translateY(4px);
  transition:opacity .24s ease-in,transform .24s ease-in}

.dsh-ov-brand{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-ov-mark{font:500 11px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  letter-spacing:.34em;text-transform:uppercase;color:rgba(255,255,255,.76);white-space:nowrap}
.dsh-ov-tagline{display:flex;align-items:center;gap:9px;min-width:0;
  font:400 12px/1.35 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  letter-spacing:.045em;color:rgba(255,255,255,.44);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ov-tagline::before{content:"";flex:0 0 auto;width:17px;height:1px;background:rgba(255,255,255,.3)}

.dsh-ov-actions{display:flex;align-items:center;gap:9px;flex:0 0 auto}
.dsh-ov-btn{appearance:none;-webkit-appearance:none;margin:0;cursor:pointer;
  height:31px;padding:0 13px;border-radius:999px;display:inline-flex;align-items:center;gap:8px;
  border:1px solid rgba(255,255,255,.17);background:rgba(255,255,255,.035);
  color:rgba(255,255,255,.7);font:500 10.5px/1 ui-sans-serif,system-ui,sans-serif;
  letter-spacing:.17em;text-transform:uppercase;
  transition:background .22s ease,border-color .22s ease,color .22s ease}
.dsh-ov-btn:hover{background:rgba(255,255,255,.11);border-color:rgba(255,255,255,.3);color:#fff}
.dsh-ov-btn:focus-visible{outline:2px solid rgba(255,255,255,.55);outline-offset:2px}
.dsh-ov-btn--icon{width:31px;padding:0;justify-content:center}
.dsh-ov-btn svg{display:block;width:14px;height:14px}
.dsh-ov-kbd{font:500 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;
  padding:3px 5px;border-radius:4px;border:1px solid rgba(255,255,255,.2);color:rgba(255,255,255,.52)}

.dsh-ov-progress{position:absolute;left:0;right:0;bottom:0;height:2px;z-index:4;
  background:rgba(255,255,255,.075)}
.dsh-ov-progress i{display:block;position:absolute;inset:0;transform-origin:0 50%;transform:scaleX(0);
  background:linear-gradient(90deg,rgba(255,255,255,.28),rgba(255,255,255,.88))}
.dsh-ov.is-leaving .dsh-ov-progress{opacity:0;transition:opacity .22s ease-in}

@media (max-height:560px){.dsh-ov{--dsh-ov-bar:64px}.dsh-ov-tagline{display:none}}
@media (max-width:560px){
  .dsh-ov-chrome{padding:0 16px;gap:12px}
  .dsh-ov-mark{letter-spacing:.24em;font-size:10px}
  .dsh-ov-btn{padding:0 11px;letter-spacing:.1em}
  .dsh-ov-kbd{display:none}}
@media (prefers-reduced-motion:reduce){
  .dsh-ov{animation:none;opacity:1}
  .dsh-ov-media{animation:none}
  .dsh-ov-grain{animation:none}
  .dsh-ov-bar{transition:none}
  .dsh-ov-chrome{transition:none}}
`

    function SoundIcon ({ muted }) {
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M4 9.4h3.2L12 5.5v13l-4.8-3.9H4z',
          fill: 'currentColor', opacity: muted ? 0.45 : 0.95,
        }),
        muted
          ? h('path', { d: 'M16 9.6 21 15M21 9.6 16 15', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' })
          : h('path', { d: 'M15.6 9.2a4 4 0 0 1 0 5.6M18.3 6.9a7.4 7.4 0 0 1 0 10.2', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }))
    }

    function BootOverlay ({ settings, strings, sources }) {
      const rootRef = useRef(null)
      const videoRef = useRef(null)
      const progressRef = useRef(null)
      const timersRef = useRef([])
      const finishedRef = useRef(false)
      const mutedRef = useRef(settings.startMuted)
      const paintedRef = useRef(false)
      const [phase, setPhase] = useState('enter')
      const [armed, setArmed] = useState(false)
      const [painted, setPainted] = useState(false)
      const [failed, setFailed] = useState(false)
      const [muted, setMuted] = useState(settings.startMuted)

      const later = useCallback((fn, delay) => {
        const id = setTimeout(fn, delay)
        timersRef.current.push(id)
        return id
      }, [])

      const finish = useCallback(() => {
        if (finishedRef.current) return
        finishedRef.current = true
        try {
          sessionStorage.setItem(settings.storageKey, '1')
        } catch {
          /* private mode: replaying is harmless */
        }
        // Any terminal state must release the pre-JS curtain: a media failure
        // would otherwise leave it covering the app until its own timeout.
        window.dispatchEvent(new CustomEvent(settings.readyEvent))
        setPhase('leave')
        later(() => setPhase('gone'), 700)
      }, [later, settings.readyEvent, settings.storageKey])

      // Arm the transitions after the first paint so they actually animate,
      // and record the session marker as soon as the sequence starts.
      useEffect(() => {
        try {
          sessionStorage.setItem(settings.storageKey, '1')
        } catch {
          /* ignore */
        }
        const raf = requestAnimationFrame(() => requestAnimationFrame(() => setArmed(true)))
        return () => cancelAnimationFrame(raf)
      }, [settings.storageKey])

      // Media lifecycle. Set up exactly once: the callbacks below are stable, so
      // a phase change must not re-run setup (a second play() on a finished
      // element can restart it during the fade-out).
      useEffect(() => {
        if (finishedRef.current) return undefined
        if (reducedMotion) {
          const id = later(finish, 1400)
          return () => clearTimeout(id)
        }
        const video = videoRef.current
        if (!video) return undefined

        const announce = () => {
          if (paintedRef.current) return
          paintedRef.current = true
          setPainted(true)
          // Two frames: the video is composited before the curtain lifts, so the
          // hand-off crossfades a blurred still into the same sharp frame.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent(settings.readyEvent))
          }))
        }
        const onLoaded = () => {
          // Playback starts on the first decoded frame, not at mount: the video
          // then begins moving exactly as the curtain crossfades, instead of
          // being ~0.3s in by the time the hand-off lands.
          announce()
          play()
        }
        const onEnded = () => finish()
        const onError = () => {
          setFailed(true)
          later(finish, 1100)
        }
        // A background tab can defer playback indefinitely; cap the sequence at
        // the clip's own length (+ slack) so it can never outlive its welcome.
        const onMetadata = () => {
          const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 10
          later(finish, (duration + 6) * 1000)
        }
        const onVisibility = () => {
          if (document.visibilityState === 'visible' && !finishedRef.current) play()
        }

        video.addEventListener('loadeddata', onLoaded)
        video.addEventListener('loadedmetadata', onMetadata)
        video.addEventListener('ended', onEnded)
        video.addEventListener('error', onError)
        document.addEventListener('visibilitychange', onVisibility)
        video.muted = mutedRef.current

        const play = () => {
          const attempt = video.play()
          if (!attempt || typeof attempt.catch !== 'function') return
          attempt.catch(() => {
            // Autoplay with sound can be refused: retry muted once, then give up
            // gracefully rather than trapping the user behind a black frame.
            if (!video.muted) {
              video.muted = true
              mutedRef.current = true
              setMuted(true)
              video.play().catch(() => later(finish, 900))
            } else {
              later(finish, 900)
            }
          })
        }
        if (video.readyState >= 2) {
          announce()
          play()
        }

        return () => {
          video.removeEventListener('loadeddata', onLoaded)
          video.removeEventListener('loadedmetadata', onMetadata)
          video.removeEventListener('ended', onEnded)
          video.removeEventListener('error', onError)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [finish, later, settings.readyEvent])

      // Progress line, driven outside React so it never re-renders.
      useEffect(() => {
        if (reducedMotion || phase === 'gone') return undefined
        let raf = 0
        let last = -1
        const tick = () => {
          const video = videoRef.current
          const bar = progressRef.current
          if (video && bar && Number.isFinite(video.duration) && video.duration > 0) {
            const ratio = Math.min(1, Math.max(0, video.currentTime / video.duration))
            if (Math.abs(ratio - last) > 0.002) {
              last = ratio
              bar.style.transform = `scaleX(${ratio})`
            }
          }
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
      }, [phase])

      // Skip affordances. The app behind the overlay is invisible but still
      // focusable, so `Tab` is absorbed for as long as the overlay owns the frame.
      useEffect(() => {
        if (phase === 'gone') return undefined
        const onKey = (event) => {
          if (event.key === 'Tab') {
            event.preventDefault()
            return
          }
          if (event.key === 'Escape' && settings.skippable) {
            event.preventDefault()
            event.stopPropagation()
            finish()
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [finish, phase, settings.skippable])

      // Take focus while the overlay is up; it is released with the component.
      useEffect(() => {
        const node = rootRef.current
        if (node && typeof node.focus === 'function') {
          try {
            node.focus({ preventScroll: true })
          } catch {
            /* older engines: focus is an enhancement here */
          }
        }
      }, [])

      // Never trap the page: a stalled network or a decode failure still ends.
      useEffect(() => {
        if (phase === 'gone') return undefined
        const id = later(() => {
          if (!paintedRef.current) finish()
        }, 7000)
        return () => clearTimeout(id)
      }, [finish, later, phase])

      useEffect(() => () => {
        for (const id of timersRef.current) clearTimeout(id)
        timersRef.current = []
      }, [])

      const toggleSound = useCallback((event) => {
        event.stopPropagation()
        const video = videoRef.current
        if (!video) return
        const next = !video.muted
        video.muted = next
        mutedRef.current = next
        setMuted(next)
        if (!next && video.paused) video.play().catch(() => {})
      }, [])

      const onRootClick = useCallback((event) => {
        if (!settings.skippable) return
        if (event.target && event.target.closest && event.target.closest('.dsh-ov-btn')) return
        finish()
      }, [finish, settings.skippable])

      if (phase === 'gone') return null

      const base = settings.mediaBase
      const classes = ['dsh-ov']
      if (armed) classes.push('is-armed')
      if (phase === 'leave') classes.push('is-leaving')

      return h('div', {
        className: classes.join(' '),
        ref: rootRef,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'DeepSeek Harness',
        tabIndex: -1,
        onClick: onRootClick,
      },
      h('style', { key: 'style' }, CSS),
      h('div', { className: 'dsh-ov-stage', key: 'stage' },
        h('div', { className: 'dsh-ov-media' },
          h('div', {
            className: 'dsh-ov-poster',
            // webp first, jpg layered underneath as a decode fallback
            style: { backgroundImage: `url("${base}poster.webp"), url("${base}poster.jpg")` },
          }),
          h('video', {
            ref: videoRef,
            className: 'dsh-ov-video',
            style: { opacity: painted && !failed ? 1 : 0 },
            poster: `${base}poster.jpg`,
            preload: reducedMotion ? 'none' : 'auto',
            playsInline: true,
            muted: muted,
            'aria-hidden': true,
            tabIndex: -1,
          },
          (sources || []).map((source) => h('source', {
            key: source.key || source.src,
            src: source.src,
            type: source.type,
          })))),
        h('div', { className: 'dsh-ov-vignette', key: 'vignette' }),
        h('div', { className: 'dsh-ov-grain', key: 'grain' })),
      h('div', { className: 'dsh-ov-bar dsh-ov-bar--top', key: 'bar-top' }),
      h('div', { className: 'dsh-ov-bar dsh-ov-bar--bottom', key: 'bar-bottom' }),
      h('div', { className: 'dsh-ov-chrome', key: 'chrome' },
        h('div', { className: 'dsh-ov-brand' },
          h('span', { className: 'dsh-ov-mark' }, 'DeepSeek Harness'),
          h('span', { className: 'dsh-ov-tagline' }, strings.tagline)),
        h('div', { className: 'dsh-ov-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-ov-btn dsh-ov-btn--icon',
            onClick: toggleSound,
            title: muted ? strings.soundOn : strings.soundOff,
            'aria-label': muted ? strings.soundOn : strings.soundOff,
            'aria-pressed': !muted,
          }, h(SoundIcon, { muted: muted })),
          settings.skippable
            ? h('button', {
              type: 'button',
              className: 'dsh-ov-btn',
              onClick: (event) => { event.stopPropagation(); finish() },
            }, strings.skip, h('span', { className: 'dsh-ov-kbd' }, 'Esc'))
            : null)),
      h('div', { className: 'dsh-ov-progress', key: 'progress' }, h('i', { ref: progressRef })))
    }

    // Module-level bridge so the registered component stays referentially stable
    // while still receiving the settings resolved at activation time.
    let bound = null
    function BootBridge () {
      return bound ? h(BootOverlay, bound) : null
    }

    let mounted = false

    return {
      inject: ['slots'],
      apply (ctx) {
        const mount = (settings, sources) => {
          if (mounted) return
          // Nothing playable, or nothing that wants to play: stay out of the way.
          if (!settings || !settings.enabled || hasBooted(settings)) return
          mounted = true
          const language = pickLanguage(ctx)
          bound = { settings, strings: STRINGS[language] || STRINGS.en, sources }
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-bootvideo',
            order: 1000,
          }, BootBridge))
        }

        const start = (settings) => {
          if (!settings) return
          resolveSources(settings.mediaBase).then(
            (sources) => mount(settings, sources),
            () => mount(settings, directSources(settings.mediaBase)),
          )
        }

        const injected = readSettings()
        if (injected) {
          start(injected)
          return
        }
        // This carrier applied no index rows: ask the Host's settings route
        // before concluding the Host half is absent.
        fetchSettings().then(start, () => {})
      },
    }
  },
})
