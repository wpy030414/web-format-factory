#!/usr/bin/env bash
#
# Generate the test fixture corpus.
#
# Fixtures are built from real tooling rather than hand-crafted bytes, so the magic
# numbers the sniffer is tested against are the ones real encoders actually emit.
#
# Requires: ffmpeg + ffprobe, sips (macOS), cwebp/img2webp.
#   brew install webp
#
# Note two local toolchain gaps this script works around:
#   - the Homebrew ffmpeg build here has no libwebp encoder, so WebP comes from cwebp
#   - it has no libvorbis either, so Ogg Vorbis uses the native encoder with
#     `-ac 2 -strict -2` (the native encoder is stereo-only and still flagged experimental)

set -euo pipefail

OUT="${1:-tests/fixtures/generated}"
mkdir -p "$OUT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }
need ffmpeg
need ffprobe

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "generating fixtures into $OUT"

# A 1-second, 64x64 test pattern and a short tone: small enough to commit nowhere,
# real enough to exercise every parser.
VIDEO_ARGS=(-f lavfi -i "testsrc=size=64x64:rate=10:duration=1")
AUDIO_ARGS=(-f lavfi -i "sine=frequency=440:duration=1")

# ---------------------------------------------------------------- still images
ffmpeg -v error -f lavfi -i "testsrc=size=64x64:rate=1:duration=1" -frames:v 1 "$OUT/still.png" -y
ffmpeg -v error -i "$OUT/still.png" -q:v 4 "$OUT/still.jpg" -y

# A PNG that actually carries transparency. Without one, nothing exercises the
# alpha-loss warning path — and that warning is the difference between turning a
# transparent logo white and telling the user it will happen.
ffmpeg -v error -f lavfi -i "color=c=red@0.5:s=64x64,format=rgba" -frames:v 1 "$OUT/alpha.png" -y

# Note: no transparent *GIF* fixture. Every encoder available here (ffmpeg's palettegen
# on a fully transparent source hangs; Pillow emits GIF87a, which predates transparency)
# fails to produce one, so `imageHasAlpha` for GIF is unit-tested against a hand-built
# GIF89a byte stream instead. See tests/unit/alpha.test.ts.

# APNG needs MORE THAN ONE FRAME. Encoding a single-frame PNG produces a plain PNG
# with no `acTL` chunk — which is not an APNG and would make the animation tests lie.
ffmpeg -v error "${VIDEO_ARGS[@]}" -plays 0 -c:v apng "$OUT/anim.apng" -y

if command -v cwebp >/dev/null 2>&1; then
  cwebp -q 80 "$OUT/still.png" -o "$OUT/still.webp" >/dev/null 2>&1
else
  echo "  (skipping still.webp — cwebp not found)"
fi

if command -v img2webp >/dev/null 2>&1; then
  ffmpeg -v error "${VIDEO_ARGS[@]}" "$WORK/f_%03d.png" -y
  img2webp -loop 0 -d 100 "$WORK"/f_*.png -o "$OUT/anim.webp" >/dev/null 2>&1
else
  echo "  (skipping anim.webp — img2webp not found)"
fi

# HEIC via macOS sips — the only browser-decodable-on-Safari format in the corpus.
if command -v sips >/dev/null 2>&1; then
  sips -s format heic "$OUT/still.png" --out "$OUT/still.heic" >/dev/null 2>&1 \
    && echo "  still.heic ok" \
    || echo "  (skipping still.heic — sips could not encode)"
else
  echo "  (skipping still.heic — sips not found, macOS only)"
fi

# ------------------------------------------------------------------ animation
ffmpeg -v error "${VIDEO_ARGS[@]}" -vf "fps=10,scale=64:-1:flags=neighbor" "$OUT/anim.gif" -y

# ---------------------------------------------------------------------- video
ffmpeg -v error "${VIDEO_ARGS[@]}" "${AUDIO_ARGS[@]}" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$OUT/av.mp4" -y
ffmpeg -v error "${VIDEO_ARGS[@]}" "${AUDIO_ARGS[@]}" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$OUT/av.mov" -y
ffmpeg -v error "${VIDEO_ARGS[@]}" "${AUDIO_ARGS[@]}" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$OUT/av.mkv" -y
ffmpeg -v error "${VIDEO_ARGS[@]}" "${AUDIO_ARGS[@]}" \
  -c:v libvpx-vp9 -b:v 200k -c:a libopus -shortest "$OUT/av.webm" -y

# Sources on the far side of the 20 ms boundary a GIF's renderers impose.
#
# `fast60` needs a 16.7 ms frame interval — shorter than anything a GIF can show, so it is
# the fixture that exercises conforming to 50 fps and reporting the frames that did not
# fit. `fast30` is the other side of the same edge: every frame survives, but a 33.3 ms
# interval only lands on the 10 ms delay grid on average, which is what the cumulative
# alignment is for. VP9 like `av.webm`, so the test browser decodes both without a
# licensed codec being present in the build.
ffmpeg -v error -f lavfi -i "testsrc=size=64x64:rate=60:duration=1" \
  -c:v libvpx-vp9 -b:v 200k "$OUT/fast60.webm" -y
ffmpeg -v error -f lavfi -i "testsrc=size=64x64:rate=30:duration=1" \
  -c:v libvpx-vp9 -b:v 200k "$OUT/fast30.webm" -y

# ---------------------------------------------------------------------- audio
ffmpeg -v error "${AUDIO_ARGS[@]}" -c:a libmp3lame "$OUT/tone.mp3" -y
ffmpeg -v error "${AUDIO_ARGS[@]}" -c:a aac -f ipod "$OUT/tone.m4a" -y
ffmpeg -v error "${AUDIO_ARGS[@]}" -c:a aac -f adts "$OUT/tone.aac" -y
ffmpeg -v error "${AUDIO_ARGS[@]}" -c:a flac "$OUT/tone.flac" -y
ffmpeg -v error "${AUDIO_ARGS[@]}" -c:a pcm_s16le "$OUT/tone.wav" -y
ffmpeg -v error "${AUDIO_ARGS[@]}" -c:a libopus "$OUT/tone-opus.ogg" -y
# The native Vorbis encoder is stereo-only and needs the experimental flag.
ffmpeg -v error "${AUDIO_ARGS[@]}" -ac 2 -c:a vorbis -strict -2 "$OUT/tone-vorbis.ogg" -y 2>/dev/null \
  || echo "  (skipping tone-vorbis.ogg — no Vorbis encoder available)"

# --------------------------------------------------------------- Live Photo-ish
# A MOV carrying the Apple pairing identifier. This is the exact invocation the app
# must reproduce; `-movflags use_metadata_tags` is mandatory or the tag is dropped.
if ffmpeg -v error -i "$OUT/av.mov" -c copy -movflags use_metadata_tags \
     -metadata "com.apple.quicktime.content.identifier=3C1F4A2E-9B7D-4E5A-8C11-0F2D6E7A9B31" \
     "$OUT/livepair.mov" -y 2>/dev/null; then
  # Sanity-check that the tag actually survived — this is the whole point of the fixture.
  #
  # Capture first, then match. Piping straight into `grep -q` would be a pipefail trap:
  # grep closes the pipe the moment it matches, ffprobe dies of SIGPIPE, and `pipefail`
  # reports that non-zero status as the pipeline failing — a false alarm on good output.
  tags="$(ffprobe -v error -show_entries format_tags -of json "$OUT/livepair.mov" || true)"
  if [[ "$tags" == *"com.apple.quicktime.content.identifier"* ]]; then
    echo "  livepair.mov ok (pairing identifier survived)"
  else
    echo "  ERROR: livepair.mov lost its pairing identifier" >&2
    exit 1
  fi
fi

# ------------------------------------------------------------------- manifest
{
  echo "# Auto-generated. Do not edit."
  echo "# format  file  container  codecs"
  for f in "$OUT"/*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    info="$(ffprobe -v error -show_entries stream=codec_name -of csv=p=0 "$f" 2>/dev/null | paste -sd, - || true)"
    printf '%-22s %-10s\n' "$name" "${info:-?}"
  done
} > "$OUT/MANIFEST.txt"

echo
cat "$OUT/MANIFEST.txt"
echo
echo "done."
