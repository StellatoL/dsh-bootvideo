#!/usr/bin/env node
/**
 * Regenerate the boot-animation media from the maintainer's source clip.
 *
 * Trim window: source 20.000s .. 30.000s (240 frames at 24 fps).
 *   - The window is frame aligned on purpose: frames 480..719, so the trim
 *     never pulls a partial frame from a neighbouring shot.
 *   - The clip contains a hard cut at ~27.79s (shot A -> ~0.2s black -> shot B).
 *     The same 10s window is reused as-is and no fades are baked in: the
 *     overlay in `client.js` owns every fade, which keeps the asset reusable.
 *
 * Usage:
 *   node scripts/build-media.mjs                    # encode + manifest
 *   SKIP_ENCODE=1 node scripts/build-media.mjs      # manifest only (fast)
 *   FFMPEG=/path/ffmpeg FFPROBE=/path/ffprobe SRC=/path/source.mp4 node scripts/build-media.mjs
 *
 * Required encoders: libopenh264, libvpx-vp9, libopus, libwebp, aac, mjpeg.
 * A static ffmpeg build (ffmpeg.org "essentials" or gyan.dev "full") has all of them.
 *
 * This is a developer tool. It is NOT imported at plugin runtime.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mediaDir = path.join(root, 'media')
const docsDir = path.join(root, 'docs')

const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const FFPROBE = process.env.FFPROBE || 'ffprobe'
const SRC = process.env.SRC || ''
const SKIP_ENCODE = process.env.SKIP_ENCODE === '1'
const START = 20
const DURATION = 10
const FPS = 24
const FRAMES = DURATION * FPS
const POSTER_AT = 20.5

// ---------------------------------------------------------------- processes

/**
 * Spawn a child with inherited stdio. Deliberately avoids pipes: some sandboxed
 * environments refuse to let a child open a pipe for its stdio (EPERM), and
 * inherited streams also make long encodes show live progress.
 */
function runInherit (bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) reject(new Error(`${path.basename(bin)} exited with code ${code}: ${args.join(' ')}`))
      else resolve()
    })
  })
}

/** Spawn a child whose stdout is captured through a regular file, not a pipe. */
async function runCapture (bin, args) {
  const out = path.join(os.tmpdir(), `build-media-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const fd = openSync(out, 'w')
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', fd, 'inherit'] })
      child.on('error', reject)
      child.on('close', code => {
        if (code !== 0) reject(new Error(`${path.basename(bin)} exited with code ${code}: ${args.join(' ')}`))
        else resolve()
      })
    })
    return await readFile(out, 'utf8')
  } finally {
    closeSync(fd)
    await unlink(out).catch(() => {})
  }
}

// ------------------------------------------------------------------ probing

async function ffprobeJson (file) {
  return JSON.parse(await runCapture(FFPROBE, [
    '-hide_banner', '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', file,
  ]))
}

async function describeVideo (file) {
  const info = await ffprobeJson(file)
  const video = info.streams.find(stream => stream.codec_type === 'video') ?? {}
  const audio = info.streams.find(stream => stream.codec_type === 'audio')
  const bytes = (await stat(file)).size
  return {
    bytes,
    sha256: createHash('sha256').update(await readFile(file)).digest('hex'),
    kind: 'video',
    container: path.extname(file).slice(1),
    codec: video.codec_name,
    profile: video.profile,
    width: video.width,
    height: video.height,
    pixFmt: video.pix_fmt,
    // The trim is exact, so report the authored frame count rather than the
    // container's free-form duration (VP9/WebM does not store nb_frames).
    frames: FRAMES,
    fps: `${FPS}/1`,
    durationSeconds: DURATION,
    bitrateKbps: Math.round(bytes * 8 / 1000 / DURATION),
    audio: audio
      ? { codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels }
      : null,
  }
}

async function describeImage (file) {
  const info = await ffprobeJson(file)
  const video = info.streams.find(stream => stream.codec_type === 'video') ?? {}
  const bytes = (await stat(file)).size
  return {
    bytes,
    sha256: createHash('sha256').update(await readFile(file)).digest('hex'),
    kind: 'image',
    codec: video.codec_name,
    width: video.width,
    height: video.height,
    sourceTimestampSeconds: POSTER_AT,
  }
}

// ------------------------------------------------------------------- encode

async function encode () {
  const trim = ['-ss', String(START), '-t', String(DURATION), '-i', SRC]

  // H.264 / MP4: broad compatibility (Safari, older Chromium, hardware decoders).
  // libopenh264 is the H.264 encoder available in the static ffmpeg build this
  // project was authored with; -rc_mode 1 selects bitrate mode.
  console.log('• media/boot.mp4 (H.264)')
  await runInherit(FFMPEG, [
    '-hide_banner', '-v', 'error', '-y', ...trim,
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'libopenh264', '-profile:v', 'main', '-rc_mode', '1',
    '-b:v', '1500k', '-maxrate', '2200k', '-bufsize', '3000k',
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    path.join(mediaDir, 'boot.mp4'),
  ])

  // VP9 / WebM: smaller payload for Chromium and Firefox.
  console.log('• media/boot.webm (VP9)')
  await runInherit(FFMPEG, [
    '-hide_banner', '-v', 'error', '-y', ...trim,
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'libvpx-vp9', '-crf', '31', '-b:v', '0',
    '-row-mt', '1', '-deadline', 'good', '-cpu-used', '1',
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', '24',
    '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2',
    path.join(mediaDir, 'boot.webm'),
  ])

  const posterAt = ['-ss', String(POSTER_AT), '-i', SRC, '-frames:v', '1']
  console.log('• media/poster.jpg + media/poster.webp')
  await runInherit(FFMPEG, [
    '-hide_banner', '-v', 'error', '-y', ...posterAt,
    '-vf', 'scale=1280:720:flags=lanczos', '-q:v', '3',
    path.join(mediaDir, 'poster.jpg'),
  ])
  await runInherit(FFMPEG, [
    '-hide_banner', '-v', 'error', '-y', ...posterAt,
    '-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libwebp', '-quality', '82', '-compression_level', '6',
    path.join(mediaDir, 'poster.webp'),
  ])

  // Tiny blurred placeholder (~350 B) that the boot curtain inlines as base64,
  // so the very first paint already shows the clip's light and colour.
  console.log('• media/curtain.jpg (48px blur placeholder)')
  await runInherit(FFMPEG, [
    '-hide_banner', '-v', 'error', '-y', ...posterAt,
    '-vf', 'scale=48:-2:flags=area,gblur=sigma=2', '-q:v', '7',
    path.join(mediaDir, 'curtain.jpg'),
  ])
}

// --------------------------------------------------------------------- main

async function main () {
  if (!SKIP_ENCODE && !SRC) {
    console.error('SRC is not set. Point it at the source clip, e.g.\n  SRC="C:/clips/source.mp4" node scripts/build-media.mjs')
    process.exit(2)
  }
  await mkdir(mediaDir, { recursive: true })
  await mkdir(docsDir, { recursive: true })

  if (!SKIP_ENCODE) await encode()

  const files = {
    'media/boot.mp4': await describeVideo(path.join(mediaDir, 'boot.mp4')),
    'media/boot.webm': await describeVideo(path.join(mediaDir, 'boot.webm')),
    'media/poster.jpg': await describeImage(path.join(mediaDir, 'poster.jpg')),
    'media/poster.webp': await describeImage(path.join(mediaDir, 'poster.webp')),
    'media/curtain.jpg': await describeImage(path.join(mediaDir, 'curtain.jpg')),
  }
  const payloadBytes = Object.values(files).reduce((sum, entry) => sum + entry.bytes, 0)

  const manifest = {
    source: SRC ? path.basename(SRC) : 'source.mp4',
    trim: { start: START, duration: DURATION, frames: FRAMES, fps: FPS, posterAt: POSTER_AT },
    files,
    payloadBytes,
    dominantColor: '#21191c',
    audio: { present: true, loudnessLufs: -11.8 },
    notes: 'No fades are baked in. media/curtain.jpg is the inline base64 first-paint placeholder.',
  }
  await writeFile(path.join(docsDir, 'media.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  for (const [rel, entry] of Object.entries(files)) {
    const detail = entry.kind === 'video'
      ? `${entry.codec} ${entry.width}x${entry.height} ${entry.frames} frames ${entry.durationSeconds}s ${entry.bitrateKbps}kbps audio=${entry.audio?.codec ?? 'none'}`
      : `${entry.codec} ${entry.width}x${entry.height}`
    console.log(`  ${rel.padEnd(22)} ${String(entry.bytes).padStart(8)} B  ${detail}`)
  }
  console.log(`  total payload ${(payloadBytes / 1024).toFixed(1)} KB`)
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
