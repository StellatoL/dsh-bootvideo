/**
 * dsh-openvideo — Host half.
 *
 * Three carrier-facing pieces, all on services the Web surface provides:
 *
 * 1. **Media route.** `media/*` is served from a named prefix route. The
 *    package-asset route only answers image extensions, so video needs its own;
 *    this one supports `Range` (the browser seeks with it), `HEAD`, and
 *    conditional `If-None-Match` revalidation.
 *
 * 2. **Settings route.** `GET /dsh-openvideo/config` returns the resolved
 *    settings. The Client half reads an injected global when one is present and
 *    falls back to this route otherwise, so the boot sequence still runs on a
 *    carrier that does not apply index injections.
 *
 * 3. **Index rows.** `webserver/index-inject` is the carrier-independent table
 *    the shell renders into `index.html` (a Web response) or applies to its own
 *    document (the Desktop `dsh-app://app/` window). The rows carry the settings
 *    global and the pre-JS curtain. `tapIndex` is deliberately NOT used: the
 *    Desktop serves its own index and never runs index transforms.
 *
 * No `Config` schema is exported on purpose: the bundle then has zero runtime
 * dependencies and still resolves from any profile. Settings are read
 * defensively from the Loader row's `config`, so a missing or partial config is
 * valid. See README.md for the patch row that overrides them.
 */

import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Browser-facing base of the media route. The route itself is registered
 * without the trailing slash: a `prefix` route matches `p` and `p/<anything>`,
 * so registering `/dsh-openvideo/media/` would only match `.../media//…`.
 */
const MEDIA_PATH = '/dsh-openvideo/media/'

/** Route path handed to the Web carrier (no trailing slash, see above). */
const MEDIA_ROUTE = '/dsh-openvideo/media'

/** Settings route the Client half falls back to. */
const CONFIG_ROUTE = '/dsh-openvideo/config'

/** Media this route is allowed to answer. Anything else is a 404, not a file read. */
const ALLOWED_FILES = new Set(['boot.mp4', 'boot.webm', 'poster.jpg', 'poster.webp', 'curtain.jpg'])

const MEDIA_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/** Window event the client overlay dispatches once its first frame is painted. */
const READY_EVENT = 'dsh-openvideo:ready'

/** sessionStorage key used by `playMode: oncePerSession`. */
const STORAGE_KEY = 'dsh-openvideo:booted'

/** Global the client half reads its settings from, when injections are applied. */
const CONFIG_GLOBAL = '__DSH_OPENVIDEO__'

/** The Web carrier is required; everywhere else this bundle stays inactive. */
export const inject = ['webServer']

const DEFAULTS = {
  enabled: true,
  playMode: 'always',
  startMuted: true,
  skippable: true,
  curtain: true,
}

/** Coerce a free-form Loader config into known fields with valid values. */
function normalizeConfig (raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const enabled = input.enabled === undefined ? DEFAULTS.enabled : Boolean(input.enabled)
  const playMode = input.playMode === 'oncePerSession' ? 'oncePerSession' : 'always'
  return {
    enabled,
    playMode,
    startMuted: input.startMuted === undefined ? DEFAULTS.startMuted : Boolean(input.startMuted),
    skippable: input.skippable === undefined ? DEFAULTS.skippable : Boolean(input.skippable),
    curtain: input.curtain === undefined ? DEFAULTS.curtain : Boolean(input.curtain),
  }
}

/** The settings both the injected global and the config route carry. */
function publicSettings (settings) {
  return {
    enabled: settings.enabled,
    playMode: settings.playMode,
    startMuted: settings.startMuted,
    skippable: settings.skippable,
    mediaBase: MEDIA_PATH,
    readyEvent: READY_EVENT,
    storageKey: STORAGE_KEY,
  }
}

/** Parse a single `Range: bytes=a-b` header against a known length. */
function parseRange (header, size) {
  if (typeof header !== 'string') return null
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  let start
  let end
  if (rawStart === '') {
    // suffix range: the last N bytes
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return null
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= size) return { unsatisfiable: true }
  return { start, end: Math.min(end, size - 1) }
}

function notFound () {
  return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
}

function mediaTypeOf (file) {
  return MEDIA_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

/**
 * Bind the Host half to one Loader row.
 * @param ctx - Cordis context; `webServer` is injected.
 * @param config - the row's config object, already coerced.
 */
export function apply (ctx, config) {
  const settings = normalizeConfig(config)
  const mediaDir = fileURLToPath(new URL('./media/', import.meta.url))
  const curtainBytes = (() => {
    try {
      return readFileSync(new URL('./media/curtain.jpg', import.meta.url))
    } catch {
      return null
    }
  })()

  /** @type {Map<string, { bytes: Buffer, etag: string, mtimeMs: number, size: number }>} */
  const cache = new Map()

  async function loadMedia (file) {
    const absolute = path.join(mediaDir, file)
    // Defence in depth: ALLOWED_FILES already keeps this a single plain name.
    if (path.dirname(absolute) !== path.resolve(mediaDir)) return null
    const info = await stat(absolute)
    if (!info.isFile()) return null
    const cached = cache.get(file)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached
    const bytes = await readFile(absolute)
    const entry = { bytes, etag: `W/"${info.size}-${Math.round(info.mtimeMs)}"`, mtimeMs: info.mtimeMs, size: info.size }
    cache.set(file, entry)
    return entry
  }

  async function serveMedia (request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
    }
    let pathname
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return notFound()
    }
    if (!pathname.startsWith(MEDIA_PATH)) return notFound()
    const file = pathname.slice(MEDIA_PATH.length)
    if (!ALLOWED_FILES.has(file)) return notFound()

    let entry
    try {
      entry = await loadMedia(file)
    } catch {
      entry = null
    }
    if (!entry) return notFound()

    const headers = {
      'content-type': mediaTypeOf(file),
      'accept-ranges': 'bytes',
      etag: entry.etag,
      'cache-control': 'public, max-age=0, must-revalidate',
    }

    if (request.headers.get('if-none-match') === entry.etag) {
      return new Response(null, { status: 304, headers })
    }

    const range = parseRange(request.headers.get('range'), entry.size)
    if (range && range.unsatisfiable) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'content-range': `bytes */${entry.size}` },
      })
    }
    if (range) {
      const chunk = entry.bytes.subarray(range.start, range.end + 1)
      headers['content-range'] = `bytes ${range.start}-${range.end}/${entry.size}`
      headers['content-length'] = String(chunk.byteLength)
      return new Response(request.method === 'HEAD' ? null : chunk, { status: 206, headers })
    }
    headers['content-length'] = String(entry.size)
    return new Response(request.method === 'HEAD' ? null : entry.bytes, { status: 200, headers })
  }

  async function serveConfig (request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
    }
    const body = JSON.stringify(publicSettings(settings))
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const rows = buildInjectionRows({
    settings,
    mediaBase: MEDIA_PATH,
    curtainEnabled: settings.enabled && settings.curtain,
    curtainDataUrl: curtainBytes ? `data:image/jpeg;base64,${curtainBytes.toString('base64')}` : '',
  })

  ctx.effect(() => {
    const disposeMedia = ctx.webServer.register({
      kind: 'prefix',
      path: MEDIA_ROUTE,
      resource: (request) => serveMedia(request),
    })
    const disposeConfig = ctx.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      resource: (request) => serveConfig(request),
    })
    // Structured rows reach both carriers: the Web response renders them into
    // index.html, and the Desktop shell applies the same table to its document.
    const disposeInject = ctx.on('webserver/index-inject', (table) => {
      if (Array.isArray(table)) table.push(...rows)
    })
    return () => {
      disposeInject()
      disposeConfig()
      disposeMedia()
    }
  })
}

/**
 * Build the index rows once. Rows are plain data, read fresh at emit time.
 * Only the settings global is always pushed; the curtain (styles, markup and
 * its inline behaviour) is optional.
 */
function buildInjectionRows ({ settings, mediaBase, curtainEnabled, curtainDataUrl }) {
  const rows = [{ kind: 'global', name: CONFIG_GLOBAL, value: publicSettings(settings) }]
  if (!curtainEnabled || !curtainDataUrl) return rows
  rows.push({ kind: 'style', text: CURTAIN_CSS.replace('__CURTAIN_IMAGE__', curtainDataUrl) })
  rows.push({ kind: 'html', placement: 'body', html: CURTAIN_MARKUP })
  rows.push({
    kind: 'script',
    placement: 'head',
    text: curtainScript(READY_EVENT, STORAGE_KEY, settings.playMode),
  })
  return rows
}

/** The curtain markup: one fixed layer, image inlined as a data URL by the style row. */
const CURTAIN_MARKUP = '<div id="dsh-openvideo-curtain" role="presentation">'
  + '<div class="dsh-ovc-frame"></div>'
  + '<div class="dsh-ovc-glow"></div>'
  + '<div class="dsh-ovc-foot">'
  + '<span class="dsh-ovc-mark">DeepSeek Harness</span>'
  + '<span class="dsh-ovc-track"><i class="dsh-ovc-bar"></i></span>'
  + '</div>'
  + '</div>'

/**
 * The curtain's inline behaviour. It decides early (disabled / already seen),
 * re-checks the boot graph once the document is parsed (a missing client entry
 * means no animation is coming), and lifts on the overlay's ready event with a
 * timeout as the last resort.
 */
function curtainScript (readyEvent, storageKey, playMode) {
  return `(function(){try{
var root=document.documentElement;
var cfg=window.${CONFIG_GLOBAL}||{};
var seen=false;
try{seen=sessionStorage.getItem(${JSON.stringify(storageKey)})==='1'}catch(e){}
if(cfg.enabled===false||(${JSON.stringify(playMode)}==='oncePerSession'&&seen)){root.classList.add('dsh-ovc-skip');return}
var done=false;
function lift(){
  if(done)return;done=true;
  var el=document.getElementById('dsh-openvideo-curtain');
  if(!el){root.classList.add('dsh-ovc-skip');return}
  el.classList.add('dsh-ovc-lift');
  setTimeout(function(){if(el.parentNode)el.parentNode.removeChild(el)},420);
}
function checkEntry(){
  var graph=window.__DSH_BOOT__;
  if(!graph||!graph.entries)return;
  var present=graph.entries.some(function(e){return e&&e.id==='dsh-openvideo'});
  if(!present){done=true;root.classList.add('dsh-ovc-skip');}
}
checkEntry();
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',checkEntry);
window.addEventListener(${JSON.stringify(readyEvent)},lift);
setTimeout(lift,4000);
}catch(e){try{document.documentElement.classList.add('dsh-ovc-skip')}catch(_){}}})();`
}

/**
 * Curtain styles. Kept inline and self-contained: it must paint before any
 * stylesheet from the app shell has loaded. Colours match the clip's own
 * dominant tone so the handoff to the video is invisible.
 */
const CURTAIN_CSS = `
#dsh-openvideo-curtain{position:fixed;inset:0;z-index:2147483000;overflow:hidden;background:#0b090c;
  opacity:1;transition:opacity .38s cubic-bezier(.22,1,.36,1);contain:strict;
  pointer-events:none;cursor:default;-webkit-user-select:none;user-select:none}
html.dsh-ovc-skip #dsh-openvideo-curtain{display:none!important}
#dsh-openvideo-curtain.dsh-ovc-lift{opacity:0}
.dsh-ovc-frame{position:absolute;inset:-6%;background:#0b090c url("__CURTAIN_IMAGE__") center/cover no-repeat;
  filter:blur(18px) saturate(1.15) brightness(1.1);transform:scale(1.06);
  animation:dsh-ovc-drift 14s ease-out both}
.dsh-ovc-glow{position:absolute;inset:0;
  background:radial-gradient(120% 90% at 50% 42%,rgba(255,236,240,.10) 0%,rgba(11,9,12,0) 58%),
             linear-gradient(180deg,rgba(11,9,12,.55) 0%,rgba(11,9,12,.05) 34%,rgba(11,9,12,.72) 100%)}
.dsh-ovc-foot{position:absolute;left:0;right:0;bottom:0;padding:0 34px 26px;display:flex;flex-direction:column;gap:14px}
.dsh-ovc-mark{font:500 11px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  letter-spacing:.34em;text-transform:uppercase;color:rgba(255,255,255,.62);
  animation:dsh-ovc-rise .7s cubic-bezier(.22,1,.36,1) .12s both}
.dsh-ovc-track{position:relative;display:block;height:1px;background:rgba(255,255,255,.10);overflow:hidden}
.dsh-ovc-bar{position:absolute;inset:0;display:block;transform-origin:0 50%;transform:scaleX(.18);
  background:linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.72));
  animation:dsh-ovc-sweep 1.5s cubic-bezier(.45,.05,.55,.95) infinite}
@keyframes dsh-ovc-drift{from{transform:scale(1.045)}to{transform:scale(1.085)}}
@keyframes dsh-ovc-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes dsh-ovc-sweep{0%{transform:translateX(-60%) scaleX(.22)}55%{transform:translateX(20%) scaleX(.55)}100%{transform:translateX(120%) scaleX(.28)}}
@media (prefers-reduced-motion:reduce){
  .dsh-ovc-frame{animation:none}.dsh-ovc-mark{animation:none}.dsh-ovc-bar{animation:none;transform:scaleX(.42)}
}
`
