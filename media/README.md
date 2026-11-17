# Media

These files are the boot sequence itself. They are trimmed from one source clip and
encoded for the browser; nothing here is fetched at runtime from the network.

| File | Role | Size | Spec |
| --- | --- | --- | --- |
| `boot.webm` | Preferred source (`<video>` picks it first) | ~963 KB | VP9, 1280×720, 24 fps, 240 frames, Opus 96 kbps stereo |
| `boot.mp4` | Fallback for browsers without VP9 | ~1.2 MB | H.264 Main, 1280×720, 24 fps, 240 frames, AAC 128 kbps stereo |
| `poster.webp` | Sharp first paint under the overlay | ~35 KB | WebP, frame at source t = 20.5 s |
| `poster.jpg` | Fallback poster (`<video poster>`) | ~60 KB | JPEG q3, same frame |
| `curtain.jpg` | Blurred `index.html` curtain background, inlined as base64 between the browser and the Host | ~350 B | 48 px wide, blurred |

`docs/media.json` records the measured size, SHA-256, codec, and frame count of each
file; regenerate it whenever the media changes.

## Trim

Source `20.000 s .. 30.000 s` — exactly frames 480..719 of a 24 fps clip, so the trim
is frame aligned. The segment contains a hard cut at ~27.79 s followed by roughly
0.2 s of black and a second shot, which the boot sequence uses as its mid-point.

No fades, colour grading, or scaling are baked in: the overlay in `client.js` owns
every fade and the CSS push-in, so the same assets stay reusable. The only visual
change applied by the encoder is the 1.16× brightness lift done in CSS at play time.

## Regenerate

```sh
# full re-encode (needs ffmpeg with libopenh264, libvpx-vp9, libopus, libwebp)
SRC=/path/to/source.mp4 node scripts/build-media.mjs

# rewrite docs/media.json only, from the files already on disk
SKIP_ENCODE=1 node scripts/build-media.mjs
```

`FFMPEG` and `FFPROBE` override the binaries; both default to `PATH`. See
`scripts/build-media.mjs` for the exact encoder settings.

## Rights

The footage is derived from a clip supplied by the project maintainer. It is **not**
covered by this repository's MIT licence, which applies to the code only. Anyone
redistributing this bundle is responsible for holding the rights to the clip; replace
the files above (keeping the names) to ship your own material.
