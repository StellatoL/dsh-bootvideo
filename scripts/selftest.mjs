#!/usr/bin/env node
/**
 * Self-test for the Host half and the injected client bundle.
 *
 * `index.js` only depends on the Web carrier's two methods, so the whole Host
 * half can be driven here with a fake context: registration is recorded, the
 * media resource is called with real `Request` objects, and the index transform
 * is applied to the real shell document. No DSH process is needed.
 *
 * Run: node scripts/selftest.mjs [path-to-index.html]
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The shell document this plugin is injected into (any index.html works). */
const FALLBACK_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>DeepSeek Harness</title>
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`

let failures = 0
let checks = 0

function check (label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok    ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Slice out a template-literal body that starts after `marker`. */
function templateOf (source, marker) {
  const at = source.indexOf(marker)
  if (at < 0) return null
  const from = source.indexOf('`', at) + 1
  const to = source.indexOf('`', from)
  if (from <= 0 || to < 0) return null
  return source.slice(from, to)
}

/** Final and minimum nesting depth of one bracket pair, ignoring quoted runs. */
function balance (text, open, close) {
  let depth = 0
  let min = 0
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote) {
      if (char === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
    } else if (char === open) {
      depth += 1
    } else if (char === close) {
      depth -= 1
      if (depth < min) min = depth
    }
  }
  return { final: depth, min }
}

function fakeContext (config) {
  const routes = []
  const taps = []
  const effects = []
  const ctx = {
    webServer: {
      register (route) {
        routes.push(route)
        return () => {}
      },
      tapIndex (transform) {
        taps.push(transform)
        return () => {}
      },
    },
    effect (callback) {
      effects.push(callback())
      return () => {}
    },
    get () {
      return undefined
    },
  }
  apply(ctx, config)
  return { routes, taps, effects }
}

async function main () {
  const indexHtml = await readFile(
    process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'test', 'fixtures', 'index.html'),
    'utf8',
  ).catch(() => FALLBACK_INDEX)

  console.log('Host half — route registration')
  const { routes, taps, effects } = fakeContext({})
  check('registers exactly one route', routes.length === 1, `got ${routes.length}`)
  check('registers exactly one index tap', taps.length === 1, `got ${taps.length}`)
  check('route is a prefix route', routes[0]?.kind === 'prefix', routes[0]?.kind)
  check('route path has no trailing slash', routes[0]?.path === '/dsh-openvideo/media', routes[0]?.path)
  check('effects were created', effects.length >= 1, `got ${effects.length}`)

  const resource = routes[0].resource

  console.log('\nHost half — media resource')
  const base = 'http://placeholder/dsh-openvideo/media/'
  const expected = {
    'boot.webm': 'video/webm',
    'boot.mp4': 'video/mp4',
    'poster.webp': 'image/webp',
    'poster.jpg': 'image/jpeg',
    'curtain.jpg': 'image/jpeg',
  }
  for (const [file, type] of Object.entries(expected)) {
    const response = await resource(new Request(`${base}${file}`))
    const body = Buffer.from(await response.arrayBuffer())
    check(`${file} -> 200`, response.status === 200, String(response.status))
    check(`${file} content-type`, response.headers.get('content-type') === type, response.headers.get('content-type'))
    check(`${file} accepts ranges`, response.headers.get('accept-ranges') === 'bytes')
    check(`${file} has etag`, Boolean(response.headers.get('etag')))
    check(`${file} body non-empty`, body.byteLength > 0, `${body.byteLength} bytes`)
  }

  const notAllowed = await resource(new Request(`${base}../index.js`))
  check('path traversal is a 404', notAllowed.status === 404, String(notAllowed.status))
  const unknown = await resource(new Request(`${base}nope.mp4`))
  check('unknown file is a 404', unknown.status === 404, String(unknown.status))
  const post = await resource(new Request(`${base}boot.mp4`, { method: 'POST' }))
  check('POST is a 405', post.status === 405, String(post.status))
  check('405 advertises Allow', post.headers.get('allow') === 'GET, HEAD', post.headers.get('allow'))

  console.log('\nHost half — range, HEAD and revalidation')
  const total = Number((await resource(new Request(`${base}boot.webm`))).headers.get('content-length'))
  const ranged = await resource(new Request(`${base}boot.webm`, { headers: { range: 'bytes=100-199' } }))
  const rangedBytes = Buffer.from(await ranged.arrayBuffer())
  check('range -> 206', ranged.status === 206, String(ranged.status))
  check('range length is 100', rangedBytes.byteLength === 100, `${rangedBytes.byteLength} bytes`)
  check('range content-range header', ranged.headers.get('content-range') === `bytes 100-199/${total}`, ranged.headers.get('content-range'))

  const suffix = await resource(new Request(`${base}poster.jpg`, { headers: { range: 'bytes=-50' } }))
  check('suffix range -> 206', suffix.status === 206, String(suffix.status))
  check('suffix range length is 50', (await suffix.arrayBuffer()).byteLength === 50)

  const unsatisfiable = await resource(new Request(`${base}poster.jpg`, { headers: { range: `bytes=${total + 10}-` } }))
  check('unsatisfiable range -> 416', unsatisfiable.status === 416, String(unsatisfiable.status))

  const head = await resource(new Request(`${base}boot.mp4`, { method: 'HEAD' }))
  check('HEAD -> 200 with no body', head.status === 200 && (await head.arrayBuffer()).byteLength === 0)

  const etag = (await resource(new Request(`${base}boot.mp4`))).headers.get('etag')
  const revalidated = await resource(new Request(`${base}boot.mp4`, { headers: { 'if-none-match': etag } }))
  check('matching If-None-Match -> 304', revalidated.status === 304, String(revalidated.status))

  console.log('\nHost half — index injection')
  const injected = taps[0](indexHtml)
  // Whatever the shipped document calls its module entry, the injection must
  // not disturb it. Derive the name from the input instead of hardcoding one.
  const appScript = indexHtml.match(/<script[^>]*\ssrc="([^"]+)"/u)?.[1]
  const shellRoot = /<div id="root"/u.test(indexHtml)
  check('marks the document', injected.includes('dsh-openvideo'))
  check('injects the settings global', injected.includes('window.__DSH_OPENVIDEO__='))
  check('injects the curtain div', injected.includes('id="dsh-openvideo-curtain"'))
  check('injects the curtain style', injected.includes('data-dsh-openvideo="curtain"'))
  check('inlines the curtain image as base64', /data:image\/jpeg;base64,[A-Za-z0-9+/=]{200,}/u.test(injected))
  check('keeps the shell root', !shellRoot || injected.includes('<div id="root"'))
  check('keeps the app entry script', !appScript || injected.includes(appScript), appScript)
  check('is idempotent', taps[0](injected) === injected, 'second pass changed the document')
  check('curtain is the first body child',
    injected.indexOf('id="dsh-openvideo-curtain"') > injected.indexOf('<body')
    && (!shellRoot || injected.indexOf('id="dsh-openvideo-curtain"') < injected.indexOf('<div id="root"')))

  const settings = JSON.parse(injected.match(/window\.__DSH_OPENVIDEO__=(\{.*?\})<\/script>/su)[1])
  check('settings carry the media base', settings.mediaBase === '/dsh-openvideo/media/', settings.mediaBase)
  check('settings carry defaults', settings.enabled === true && settings.playMode === 'always')

  console.log('\nHost half — injected script parses')
  const scripts = [...injected.matchAll(/<script data-dsh-openvideo="curtain">([\s\S]*?)<\/script>/gu)]
  check('exactly one curtain script', scripts.length === 1, `got ${scripts.length}`)
  try {
    new Function(scripts[0][1]) // eslint-disable-line no-new-func
    check('curtain script is valid JavaScript', true)
  } catch (error) {
    check('curtain script is valid JavaScript', false, error.message)
  }
  check('config is inlined safely', !injected.includes('</script><script>null'))

  console.log('\nHost half — settings')
  const disabled = fakeContext({ enabled: false })
  const disabledHtml = disabled.taps[0](indexHtml)
  check('disabled still exposes settings (client stays inert)', disabledHtml.includes('window.__DSH_OPENVIDEO__='))
  check('disabled injects no curtain', !disabledHtml.includes('id="dsh-openvideo-curtain"'))

  const noCurtain = fakeContext({ curtain: false })
  check('curtain:false injects no curtain markup', !noCurtain.taps[0](indexHtml).includes('id="dsh-openvideo-curtain"'))
  check('curtain:false keeps the settings global', noCurtain.taps[0](indexHtml).includes('window.__DSH_OPENVIDEO__='))

  const once = fakeContext({ playMode: 'oncePerSession' })
  check('playMode reaches the client', once.taps[0](indexHtml).includes('"playMode":"oncePerSession"'))

  console.log('\nClient half — bundle shape')
  const client = await readFile(path.join(root, 'client.js'), 'utf8')
  check('registers through the module loader', client.includes('window.__ModuleLoader__.load({'))
  check('declares the package id', /id:\s*'dsh-openvideo'/.test(client))
  check('registers into shell.overlay', client.includes("ctx.slots.inject('shell.overlay'"))
  check('opts back into pointer events', /\.dsh-ov\{[^}]*pointer-events:auto/.test(client))
  check('curtain never blocks the overlay', /#dsh-openvideo-curtain\{[^}]*pointer-events:none/.test(await readFile(path.join(root, 'index.js'), 'utf8')))
  check('is a modal surface for assistive tech', client.includes("'aria-modal': 'true'") && client.includes('role: \'dialog\''))
  check('takes focus while it owns the frame', client.includes('rootRef.current') && client.includes('.focus({ preventScroll: true })'))
  check('does not start playback before the first frame', /const onLoaded = \(\) => \{[\s\S]{0,260}play\(\)/.test(client))
  check('has a reduced-motion path', client.includes('prefers-reduced-motion'))
  check('handles autoplay refusal', client.includes('.play()') && client.includes('catch'))
  check('cleans up its timers', client.includes('timersRef'))
  check('never writes DOM outside the tree', !client.includes('document.body.appendChild'))
  check('sends the ready event for the curtain', client.includes('dispatchEvent(new CustomEvent'))

  console.log('\nStylesheets — structural sanity')
  const hostSource = await readFile(path.join(root, 'index.js'), 'utf8')
  const stylesheets = [
    ['client.js overlay', templateOf(client, 'const CSS = `')],
    ['index.js curtain', templateOf(hostSource, 'const CURTAIN_CSS = `')],
  ]
  for (const [label, css] of stylesheets) {
    check(`${label} stylesheet found`, typeof css === 'string' && css.length > 200, `${css ? css.length : 0} chars`)
    if (!css) continue
    const braces = balance(css, '{', '}')
    const parens = balance(css, '(', ')')
    check(`${label} braces balance`, braces.final === 0, `final depth ${braces.final}`)
    check(`${label} braces never underflow`, braces.min >= 0, `min depth ${braces.min}`)
    check(`${label} parens balance`, parens.final === 0, `final depth ${parens.final}`)
    check(`${label} has no stray style close tag`, !css.includes('</style'))
    check(`${label} has no empty declaration`, !css.includes(';;'))
  }
  const posterWired = /className: 'dsh-ov-media'[\s\S]{0,400}className: 'dsh-ov-poster'/.test(client)
  check('poster and video share one animated wrapper', posterWired)

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) {
    console.log(`${failures} FAILED`)
    process.exit(1)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
