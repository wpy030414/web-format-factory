/**
 * Shared vocabulary for the whole conversion pipeline.
 *
 * Everything downstream — probing, routing, loss annotation, UI — speaks these types.
 * They are deliberately small and closed: adding a format or a loss code is a deliberate
 * edit here, not an incidental side effect of some engine's capabilities.
 */

/** What kind of media a file actually *is*, determined by content — never by extension. */
export type MediaClass =
  | 'video'
  | 'animated-image'
  | 'still-image'
  | 'audio'
  /** A bundle: a still plus a short video sharing a pairing identifier. */
  | 'live-photo'
  | 'unknown';

/** Container families we recognise. `unknown` is a first-class outcome, not an error. */
export type ContainerId =
  | 'jpeg' // JFIF / EXIF
  | 'png' // PNG, optionally APNG
  | 'webp' // RIFF WebP, still or animated
  | 'gif' // GIF87a / GIF89a
  | 'isobmff-mp4' // ftyp: isom / iso2 / mp41 / mp42
  | 'isobmff-mov' // ftyp: 'qt  '
  | 'isobmff-m4a' // ftyp: 'M4A ' / 'M4B '
  | 'isobmff-heic' // ftyp: heic / heix / mif1 / msf1
  | 'matroska' // EBML DocType 'matroska'
  | 'webm' // EBML DocType 'webm'
  | 'ogg' // OggS
  | 'mp3' // MPEG-1/2 Layer III
  | 'adts' // raw AAC
  | 'flac' // fLaC
  | 'wav' // RIFF WAVE
  | 'zip'; // .livp and friends

/** Codecs we care about. Not exhaustive — enough to reason about routability. */
export type CodecId =
  // video
  | 'avc'
  | 'hevc'
  | 'vp8'
  | 'vp9'
  | 'av1'
  | 'prores'
  | 'gif-lzw'
  | 'webp-vp8'
  // audio
  | 'aac'
  | 'opus'
  | 'mp3'
  | 'vorbis'
  | 'flac'
  | 'alac'
  | 'pcm';

/** Target formats offered in the UI. Every one of these is something we can *write*. */
export type FormatId =
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'webp-anim'
  | 'gif'
  | 'apng'
  | 'mp4'
  | 'mov'
  | 'mkv'
  | 'webm'
  | 'live-photo'
  | 'motion-photo'
  | 'm4a'
  | 'mp3'
  | 'aac'
  | 'flac'
  | 'wav'
  | 'ogg';

export type FormatFamily = 'image' | 'video' | 'audio' | 'live';

/** Which engine family can actually do a piece of work. */
export type EngineId = 'image-native' | 'mediabunny' | 'wasm-kernels' | 'ffmpeg';

/**
 * How a conversion relates to the source's content.
 *
 * Derived from two orthogonal axes, never declared — see `kindOf()` in ./routes/kind.ts.
 * A declared kind can disagree with reality; a derived one cannot.
 */
export interface RouteShape {
  /** Were the compressed bytes left untouched? (`-c copy` semantics.) */
  payload: 'preserved' | 'reencoded';
  /** Did the media class change (video → image, video → audio, …)? */
  mediaClass: 'same' | 'changed';
}

export type ConversionKind = 'transmux' | 'transcode' | 'projection';

/**
 * The headline honesty verdict shown on every route.
 *
 * Note `lossless` here means "no *further* loss was introduced by this operation" —
 * it does not mean the content is pristine. MP3 → FLAC is `lossy` for exactly this reason.
 */
export type Fidelity = 'lossless' | 'lossy' | 'projection';

/** Why a conversion cannot be offered at all. Rendered as a disabled control with a reason. */
export type ImpossibilityReason =
  | 'class-mismatch'
  | 'needs-visual-component'
  | 'needs-motion-component'
  | 'needs-multiple-frames'
  | 'livephoto-needs-video'
  | 'no-encoder-in-browser'
  | 'no-decoder-in-browser'
  | 'container-cannot-hold-codec'
  | 'param-unsupported'
  | 'engine-unavailable';
