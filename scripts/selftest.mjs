#!/usr/bin/env node
/**
 * Self-test for the Host half and the injected client bundle.
 *
 * `index.js` only depends on the Web carrier's route table, its index-injection
 * event and Cordis effects, so the whole Host half can be driven here with a
 * fake context: routes are registered, the media resource is called with real
 * `Request` objects, and the injection rows are emitted into a table exactly as
 * the shell does. Rows are then applied to the real shell document the way the
 * shipped frontend applies them, so the curtain is verified end to end.
 *
 * Run: node scripts/selftest.mjs
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The shell document the rows are injected into (copy of the shipped dist index). */
const INDEX_FIXTURE = path.join(root, 'test', 'fixtures', 'index.html')

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

/**
 * Mirror of the shipped frontend's injection applier for the row kinds this
 * bundle uses: `style` (and `script`) go into <head>, body `html` is appended
 * to <body>, and a `global` row assigns `window[name]`.
 */
function applyRows (html, rows) {
  let out = html
  const window = {}
  for (const row of rows) {
    if (row.kind === 'global') {
      window[row.name] = row.value
    } else if (row.kind === 'style') {
      out = out.replace('</head>', `<style>${row.text}</style></head>`)
    } else if (row.kind === 'script') {
      const injected = `<script>${row.text}</script>`
      out = row.placement === 'body'
        ? out.replace('</body>', `${injected}</body>`)
        : out.replace('</head>', `${injected}</head>`)
    } else if (row.kind === 'html') {
      const injected = row.html
      out = row.placement === 'head'
        ? out.replace('</head>', `${injected}</head>`)
        : out.replace('</body>', `${injected}</body>`)
    }
  }
  return { html: out, window }
}

function fakeContext (config) {
  const routes = []
  const taps = []
  const injections = []
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
    on (event, listener) {
      if (event === 'webserver/index-inject') injections.push(listener)
      return () => {}
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
  return { routes, taps, injections, effects }
}

function rowOf (rows, kind) {
  return rows.find((row) => row.kind === kind)
}

async function main () {
  const indexHtml = await readFile(INDEX_FIXTURE, 'utf8')
  const hostSource = await readFile(path.join(root, 'index.js'), 'utf8')
  const client = await readFile(path.join(root, 'client.js'), 'utf8')

  console.log('Host half — registration')
  const { routes, taps, injections, effects } = fakeContext({})
  check('registers two routes', routes.length === 2, `got ${routes.length}`)
  check('registers one index-injection listener', injections.length === 1, `got ${injections.length}`)
  // Regression guard: the Desktop window serves its own index and never runs
  // index transforms, so the curtain must not depend on tapIndex.
  check('no longer depends on tapIndex', taps.length === 0, `got ${taps.length} taps`)
  check('registers a prefix media route', routes.some((r) => r.kind === 'prefix' && r.path === '/dsh-bootvideo/media'))
  check('registers an exact config route', routes.some((r) => r.kind === 'exact' && r.path === '/dsh-bootvideo/config'))
  check('effects were created', effects.length >= 1, `got ${effects.length}`)

  const media = routes.find((r) => r.path === '/dsh-bootvideo/media').resource
  const config = routes.find((r) => r.path === '/dsh-bootvideo/config').resource
  const base = 'http://placeholder/dsh-bootvideo/media/'

  console.log('\nHost half — media resource')
  const expected = {
    'boot.webm': 'video/webm',
    'boot.mp4': 'video/mp4',
    'poster.webp': 'image/webp',
    'poster.jpg': 'image/jpeg',
    'curtain.jpg': 'image/jpeg',
  }
  for (const [file, type] of Object.entries(expected)) {
    const response = await media(new Request(`${base}${file}`))
    const body = Buffer.from(await response.arrayBuffer())
    check(`${file} -> 200`, response.status === 200, String(response.status))
    check(`${file} content-type`, response.headers.get('content-type') === type, response.headers.get('content-type'))
    check(`${file} accepts ranges`, response.headers.get('accept-ranges') === 'bytes')
    check(`${file} has etag`, Boolean(response.headers.get('etag')))
    check(`${file} body non-empty`, body.byteLength > 0, `${body.byteLength} bytes`)
  }
  check('path traversal is a 404', (await media(new Request(`${base}../index.js`))).status === 404)
  check('unknown file is a 404', (await media(new Request(`${base}nope.mp4`))).status === 404)
  const post = await media(new Request(`${base}boot.mp4`, { method: 'POST' }))
  check('POST is a 405', post.status === 405, String(post.status))
  check('405 advertises Allow', post.headers.get('allow') === 'GET, HEAD', post.headers.get('allow'))

  console.log('\nHost half — range, HEAD and revalidation')
  const total = Number((await media(new Request(`${base}boot.webm`))).headers.get('content-length'))
  const ranged = await media(new Request(`${base}boot.webm`, { headers: { range: 'bytes=100-199' } }))
  check('range -> 206', ranged.status === 206, String(ranged.status))
  check('range length is 100', (await ranged.arrayBuffer()).byteLength === 100)
  check('range content-range header', ranged.headers.get('content-range') === `bytes 100-199/${total}`, ranged.headers.get('content-range'))
  check('suffix range -> 206', (await media(new Request(`${base}poster.jpg`, { headers: { range: 'bytes=-50' } }))).status === 206)
  check('unsatisfiable range -> 416', (await media(new Request(`${base}poster.jpg`, { headers: { range: `bytes=${total + 10}-` } }))).status === 416)
  const head = await media(new Request(`${base}boot.mp4`, { method: 'HEAD' }))
  check('HEAD -> 200 with no body', head.status === 200 && (await head.arrayBuffer()).byteLength === 0)
  const etag = (await media(new Request(`${base}boot.mp4`))).headers.get('etag')
  check('matching If-None-Match -> 304', (await media(new Request(`${base}boot.mp4`, { headers: { 'if-none-match': etag } }))).status === 304)

  console.log('\nHost half — settings route')
  const settingsResponse = await config(new Request('http://placeholder/dsh-bootvideo/config'))
  check('config -> 200', settingsResponse.status === 200, String(settingsResponse.status))
  check('config is JSON', (settingsResponse.headers.get('content-type') || '').includes('application/json'))
  check('config is not cached', settingsResponse.headers.get('cache-control') === 'no-store')
  const served = await settingsResponse.json()
  check('config carries the media base', served.mediaBase === '/dsh-bootvideo/media/', served.mediaBase)
  check('config carries the defaults', served.enabled === true && served.playMode === 'always' && served.skippable === true)
  check('config names the ready event', served.readyEvent === 'dsh-bootvideo:ready', served.readyEvent)
  check('config POST is a 405', (await config(new Request('http://placeholder/dsh-bootvideo/config', { method: 'POST' }))).status === 405)

  console.log('\nHost half — injection rows')
  const table = []
  injections[0](table)
  check('pushes four rows', table.length === 4, `got ${table.length}`)
  const globalRow = rowOf(table, 'global')
  check('first row is the settings global', table[0] === globalRow && globalRow.name === '__DSH_BOOTVIDEO__', globalRow && globalRow.name)
  check('global row matches the config route', JSON.stringify(globalRow.value) === JSON.stringify(served))
  check('has a style row', Boolean(rowOf(table, 'style')))
  check('style row inlines the curtain image', /data:image\/jpeg;base64,[A-Za-z0-9+/=]{200,}/u.test(rowOf(table, 'style').text))
  const htmlRow = rowOf(table, 'html')
  check('html row targets the body', htmlRow && htmlRow.placement === 'body', htmlRow && htmlRow.placement)
  check('html row is the curtain markup', htmlRow && htmlRow.html.includes('id="dsh-bootvideo-curtain"'))
  const scriptRow = rowOf(table, 'script')
  check('script row targets the head', scriptRow && scriptRow.placement === 'head', scriptRow && scriptRow.placement)
  try {
    new Function(scriptRow.text) // eslint-disable-line no-new-func
    check('curtain script is valid JavaScript', true)
  } catch (error) {
    check('curtain script is valid JavaScript', false, error.message)
  }
  check('curtain script lifts on the ready event', scriptRow.text.includes('"dsh-bootvideo:ready"'))
  check('curtain script checks the boot graph once parsed', scriptRow.text.includes('DOMContentLoaded'))

  console.log('\nHost half — rows applied to the shell document')
  const applied = applyRows(indexHtml, table)
  check('document keeps the shell root', applied.html.includes('<div id="root">'))
  check('document gains the curtain', applied.html.includes('id="dsh-bootvideo-curtain"'))
  check('curtain lands inside the body', applied.html.indexOf('id="dsh-bootvideo-curtain"') > applied.html.indexOf('<body'))
  check('curtain styles land in the head', applied.html.indexOf('<style>#dsh-bootvideo-curtain') < applied.html.indexOf('</head>'))
  check('inlined image survives the round trip', applied.html.includes('data:image/jpeg;base64,'))
  check('settings global is set on window', applied.window.__DSH_BOOTVIDEO__ && applied.window.__DSH_BOOTVIDEO__.enabled === true)
  check('applied document still parses as one head/body pair',
    (applied.html.match(/<body/gu) || []).length === 1 && (applied.html.match(/<\/head>/gu) || []).length === 1)

  console.log('\nHost half — settings')
  const disabled = fakeContext({ enabled: false })
  const disabledRows = []
  disabled.injections[0](disabledRows)
  check('disabled still publishes settings', disabledRows.length >= 1 && rowOf(disabledRows, 'global'))
  check('disabled injects no curtain', !rowOf(disabledRows, 'html'))

  const noCurtain = fakeContext({ curtain: false })
  const noCurtainRows = []
  noCurtain.injections[0](noCurtainRows)
  check('curtain:false injects no curtain markup', !rowOf(noCurtainRows, 'html'))
  check('curtain:false keeps the settings global', Boolean(rowOf(noCurtainRows, 'global')))

  const once = fakeContext({ playMode: 'oncePerSession' })
  const onceRows = []
  once.injections[0](onceRows)
  check('playMode reaches the client', JSON.stringify(onceRows) .includes('"playMode":"oncePerSession"'))

  console.log('\nClient half — bundle shape')
  check('registers through the module loader', client.includes('window.__ModuleLoader__.load({'))
  check('declares the package id', /id:\s*'dsh-bootvideo'/.test(client))
  check('registers into shell.overlay', client.includes("ctx.slots.inject('shell.overlay'"))
  check('opts back into pointer events', /\.dsh-ov\{[^}]*pointer-events:auto/.test(client))
  check('curtain never blocks the overlay', /#dsh-bootvideo-curtain\{[^}]*pointer-events:none/.test(hostSource))
  check('is a modal surface for assistive tech', client.includes("'aria-modal': 'true'") && client.includes('role: \'dialog\''))
  check('takes focus while it owns the frame', client.includes('rootRef.current') && client.includes('.focus({ preventScroll: true })'))
  check('does not start playback before the first frame', /const onLoaded = \(\) => \{[\s\S]{0,260}play\(\)/.test(client))
  check('has a reduced-motion path', client.includes('prefers-reduced-motion'))
  check('handles autoplay refusal', client.includes('.play()') && client.includes('catch'))
  check('cleans up its timers', client.includes('timersRef'))
  check('never writes DOM outside the tree', !client.includes('document.body.appendChild'))

  console.log('\nClient half — carrier independence')
  check('falls back to the settings route', client.includes("'/dsh-bootvideo/config'"))
  check('detects the shell origin', client.includes('function isShellOrigin'))
  check('prefetches media as a blob in the shell', client.includes('URL.createObjectURL'))
  check('renders sources from resolved settings', client.includes('(sources || []).map'))
  check('single mount guard', client.includes('if (mounted) return'))

  console.log('\nStylesheets — structural sanity')
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
  check('poster and video share one animated wrapper', /className: 'dsh-ov-media'[\s\S]{0,400}className: 'dsh-ov-poster'/.test(client))

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
