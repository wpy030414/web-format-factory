import type { CodecId, ContainerId, FormatFamily, FormatId, MediaClass } from '../types.ts';

/**
 * An encoding knob we are willing to expose.
 *
 * The scope rule is "format conversion + encoding parameters ONLY" — no resizing,
 * no cropping, no rotation, no frame-rate changes. `SCOPE_ALLOWLIST` below is the
 * single place that boundary is enforced, and a unit test asserts every ParamSpec
 * declares an id drawn from it. Adding a knob therefore requires a deliberate edit
 * to that list, which is the whole point: this is the constraint most likely to be
 * eroded by accident.
 */
export type ParamId =
  | 'quality'
  | 'codec'
  | 'keyFrameInterval'
  | 'hardwareAcceleration'
  | 'alpha'
  | 'forceTranscode'
  | 'lossless'
  | 'paletteSize'
  | 'dither'
  | 'loop'
  | 'bitrate'
  | 'sampleRate'
  | 'channels';

/**
 * Parameters that change *how* the bytes are represented.
 * Deliberately excludes anything that changes *what* is represented.
 */
export const SCOPE_ALLOWLIST: readonly ParamId[] = [
  'quality',
  'codec',
  'keyFrameInterval',
  'hardwareAcceleration',
  'alpha',
  'forceTranscode',
  'lossless',
  'paletteSize',
  'dither',
  'loop',
  'bitrate',
  'sampleRate',
  'channels',
] as const;

export type ParamSpec =
  | {
      id: ParamId;
      label: string;
      help?: string;
      control: 'range';
      min: number;
      max: number;
      step: number;
      default: number;
      advanced?: boolean;
    }
  | {
      id: ParamId;
      label: string;
      help?: string;
      control: 'toggle';
      default: boolean;
      advanced?: boolean;
    }
  | {
      id: ParamId;
      label: string;
      help?: string;
      control: 'enum';
      options: ReadonlyArray<{ value: string; label: string }>;
      default: string;
      advanced?: boolean;
    };

export interface FormatTraits {
  /** Can it carry more than one frame? */
  animation: 'none' | 'supported' | 'required';
  /** Transparency support. `none` means alpha input must be flattened. */
  alpha: 'none' | 'binary' | 'full';
  /** Can it hold more than one audio track? */
  multitrack: boolean;
  /** Is there a meaningful "encode without loss" mode? */
  losslessMode: boolean;
  /** Does it carry a non-trivial metadata container? */
  metadata: boolean;
}

export interface FormatSpec {
  id: FormatId;
  label: string;
  extension: string;
  mime: string;
  family: FormatFamily;
  /** Source classes this target can accept directly. */
  acceptsClasses: readonly MediaClass[];
  containers: readonly ContainerId[];
  codecs: { video?: readonly CodecId[]; audio?: readonly CodecId[] };
  traits: FormatTraits;
  params: readonly ParamSpec[];
  /** Shown in the UI when this target has a notable caveat. */
  note?: string;
}

const QUALITY: ParamSpec = {
  id: 'quality',
  label: 'Quality',
  help: 'Higher is better looking and larger. Mapped to each codec’s native scale.',
  control: 'range',
  min: 0,
  max: 100,
  step: 1,
  default: 75,
};

const ALPHA: ParamSpec = {
  id: 'alpha',
  label: 'Keep transparency',
  help: 'Discarding transparency is irreversible. Only some containers can carry it.',
  control: 'enum',
  options: [
    { value: 'discard', label: 'Discard' },
    { value: 'keep', label: 'Keep' },
  ],
  default: 'discard',
};

/* ------------------------------------------------------------------ images */

const jpeg: FormatSpec = {
  id: 'jpeg',
  label: 'JPEG',
  extension: 'jpg',
  mime: 'image/jpeg',
  family: 'image',
  acceptsClasses: ['still-image'],
  containers: ['jpeg'],
  codecs: {},
  traits: {
    animation: 'none',
    alpha: 'none',
    multitrack: false,
    losslessMode: false,
    metadata: true,
  },
  params: [QUALITY],
  note: 'No transparency. Alpha will be flattened onto a background colour.',
};

const png: FormatSpec = {
  id: 'png',
  label: 'PNG',
  extension: 'png',
  mime: 'image/png',
  family: 'image',
  acceptsClasses: ['still-image', 'animated-image'],
  containers: ['png'],
  codecs: {},
  traits: {
    animation: 'supported',
    alpha: 'full',
    multitrack: false,
    losslessMode: true,
    metadata: true,
  },
  params: [],
};

const apng: FormatSpec = {
  id: 'apng',
  label: 'Animated PNG',
  extension: 'png',
  mime: 'image/apng',
  family: 'image',
  acceptsClasses: ['animated-image', 'video'],
  containers: ['png'],
  codecs: {},
  traits: {
    animation: 'required',
    alpha: 'full',
    multitrack: false,
    losslessMode: true,
    metadata: false,
  },
  params: [],
};

const webp: FormatSpec = {
  id: 'webp',
  label: 'WebP',
  extension: 'webp',
  mime: 'image/webp',
  family: 'image',
  acceptsClasses: ['still-image'],
  containers: ['webp'],
  codecs: {},
  traits: {
    animation: 'none',
    alpha: 'full',
    multitrack: false,
    losslessMode: true,
    metadata: true,
  },
  params: [QUALITY],
};

const webpAnim: FormatSpec = {
  id: 'webp-anim',
  label: 'Animated WebP',
  extension: 'webp',
  mime: 'image/webp',
  family: 'image',
  acceptsClasses: ['animated-image', 'video'],
  containers: ['webp'],
  codecs: {},
  traits: {
    animation: 'required',
    alpha: 'full',
    multitrack: false,
    losslessMode: false,
    metadata: false,
  },
  params: [QUALITY],
  note: 'Encoding requires the fallback engine — a ~31 MB one-time download.',
};

const gif: FormatSpec = {
  id: 'gif',
  label: 'GIF',
  extension: 'gif',
  mime: 'image/gif',
  family: 'image',
  acceptsClasses: ['animated-image', 'video'],
  containers: ['gif'],
  codecs: {},
  traits: {
    animation: 'required',
    alpha: 'binary',
    multitrack: false,
    losslessMode: false,
    metadata: false,
  },
  params: [
    QUALITY,
    {
      id: 'paletteSize',
      label: 'Palette size',
      help: 'GIF is limited to 256 colours per frame. Fewer colours means a smaller file.',
      control: 'range',
      min: 2,
      max: 256,
      step: 1,
      default: 256,
      advanced: true,
    },
    {
      id: 'dither',
      label: 'Dithering',
      help: 'Temporal dithering prevents colour banding shimmering across frames.',
      control: 'enum',
      options: [
        { value: 'none', label: 'None' },
        { value: 'ordered', label: 'Ordered (fast)' },
        { value: 'diffusion', label: 'Error diffusion (best)' },
      ],
      default: 'diffusion',
      advanced: true,
    },
  ],
  note: 'Only 256 colours and 10 ms timing granularity.',
};

const LIVE_PARAMS: readonly ParamSpec[] = [
  {
    id: 'quality',
    label: 'Still quality',
    control: 'range',
    min: 0,
    max: 100,
    step: 1,
    default: 85,
  },
];

/* ------------------------------------------------------------------- video */

const mp4: FormatSpec = {
  id: 'mp4',
  label: 'MP4',
  extension: 'mp4',
  mime: 'video/mp4',
  family: 'video',
  acceptsClasses: ['video', 'animated-image'],
  containers: ['isobmff-mp4'],
  codecs: {
    video: ['avc', 'hevc', 'av1', 'vp9'],
    audio: ['aac', 'opus', 'mp3'],
  },
  traits: {
    animation: 'none',
    alpha: 'none',
    multitrack: false,
    losslessMode: false,
    metadata: true,
  },
  params: [
    QUALITY,
    {
      id: 'codec',
      label: 'Video codec',
      control: 'enum',
      options: [
        { value: 'avc', label: 'H.264 (most compatible)' },
        { value: 'hevc', label: 'H.265 (smaller, Apple-only encode)' },
        { value: 'av1', label: 'AV1 (smallest, limited support)' },
      ],
      default: 'avc',
    },
    {
      id: 'keyFrameInterval',
      label: 'Keyframe interval (s)',
      help: 'Forces a re-encode. Shorter intervals seek faster and are larger.',
      control: 'range',
      min: 1,
      max: 30,
      step: 1,
      default: 5,
      advanced: true,
    },
    {
      id: 'hardwareAcceleration',
      label: 'Hardware acceleration',
      control: 'enum',
      options: [
        { value: 'no-preference', label: 'Automatic' },
        { value: 'prefer-hardware', label: 'Prefer hardware' },
        { value: 'prefer-software', label: 'Prefer software' },
      ],
      default: 'no-preference',
      advanced: true,
    },
  ],
};

const mov: FormatSpec = {
  id: 'mov',
  label: 'QuickTime MOV',
  extension: 'mov',
  mime: 'video/quicktime',
  family: 'video',
  acceptsClasses: ['video', 'animated-image'],
  containers: ['isobmff-mov'],
  codecs: {
    video: ['avc', 'hevc', 'prores'],
    audio: ['aac', 'pcm'],
  },
  traits: {
    animation: 'none',
    alpha: 'none',
    multitrack: true,
    losslessMode: false,
    metadata: true,
  },
  params: [
    {
      id: 'codec',
      label: 'Video codec',
      control: 'enum',
      options: [
        { value: 'avc', label: 'H.264' },
        { value: 'hevc', label: 'H.265' },
      ],
      default: 'avc',
    },
  ],
  note: 'Required container for Apple Live Photo video halves.',
};

const mkv: FormatSpec = {
  id: 'mkv',
  label: 'Matroska',
  extension: 'mkv',
  mime: 'video/x-matroska',
  family: 'video',
  acceptsClasses: ['video', 'animated-image'],
  containers: ['matroska'],
  codecs: {
    video: ['avc', 'hevc', 'vp9', 'av1', 'vp8'],
    audio: ['aac', 'opus', 'vorbis', 'flac', 'mp3'],
  },
  traits: {
    animation: 'none',
    alpha: 'none',
    multitrack: true,
    losslessMode: false,
    metadata: true,
  },
  params: [
    {
      id: 'codec',
      label: 'Video codec',
      control: 'enum',
      options: [
        { value: 'avc', label: 'H.264' },
        { value: 'vp9', label: 'VP9' },
        { value: 'av1', label: 'AV1' },
      ],
      default: 'avc',
    },
  ],
  note: 'Most permissive container. Extra tracks from a source MKV may be dropped.',
};

const webm: FormatSpec = {
  id: 'webm',
  label: 'WebM',
  extension: 'webm',
  mime: 'video/webm',
  family: 'video',
  acceptsClasses: ['video', 'animated-image'],
  containers: ['webm'],
  codecs: {
    video: ['vp8', 'vp9', 'av1'],
    audio: ['opus', 'vorbis'],
  },
  traits: {
    animation: 'none',
    alpha: 'full',
    multitrack: false,
    losslessMode: false,
    metadata: true,
  },
  params: [
    {
      id: 'codec',
      label: 'Video codec',
      control: 'enum',
      options: [
        { value: 'vp9', label: 'VP9' },
        { value: 'vp8', label: 'VP8' },
        { value: 'av1', label: 'AV1' },
      ],
      default: 'vp9',
    },
    ALPHA,
  ],
  note: 'One of the few containers that can carry transparency (VP9).',
};

/* ------------------------------------------------------------------- audio */

const audioCommon: readonly ParamSpec[] = [
  {
    id: 'bitrate',
    label: 'Bitrate (kbps)',
    control: 'range',
    min: 32,
    max: 320,
    step: 8,
    default: 192,
    advanced: true,
  },
  {
    id: 'sampleRate',
    label: 'Sample rate',
    help: 'Changing this resamples the audio. Leave as “source” unless you need otherwise.',
    control: 'enum',
    options: [
      { value: 'source', label: 'Match source' },
      { value: '44100', label: '44.1 kHz' },
      { value: '48000', label: '48 kHz' },
    ],
    default: 'source',
    advanced: true,
  },
];

const m4a: FormatSpec = {
  id: 'm4a',
  label: 'M4A (AAC)',
  extension: 'm4a',
  mime: 'audio/mp4',
  family: 'audio',
  acceptsClasses: ['audio', 'video'],
  containers: ['isobmff-m4a'],
  codecs: { audio: ['aac', 'alac'] },
  traits: {
    animation: 'none',
    alpha: 'none',
    multitrack: false,
    losslessMode: true,
    metadata: true,
  },
  params: audioCommon,
};

const mp3: FormatSpec = {
  id: 'mp3',
  label: 'MP3',
  extension: 'mp3',
  mime: 'audio/mpeg',
  family: 'audio',
  acceptsClasses: ['audio', 'video'],
  containers: ['mp3'],
  codecs: { audio: ['mp3'] },
  traits: {
    animation: 'none',
    alpha: 'none',
    multitrack: false,
    losslessMode: false,
    metadata: true,
  },
  params: audioCommon,
};

const aac: FormatSpec = {
  id: 'aac',
  label: 'AAC (raw ADTS)',
  extension: 'aac',
  mime: 'audio/aac',
  family: 'audio',
  acceptsClasses: ['audio', 'video'],
  containers: ['adts'],
  codecs: { audio: ['aac'] },
  traits: {
    animation: 'none',
    alpha: 'none',
    multitrack: false,
    losslessMode: false,
    metadata: true,
  },
  params: audioCommon,
};

const flac: FormatSpec = {
  id: 'flac',
  label: 'FLAC',
  extension: 'flac',
  mime: 'audio/flac',
  family: 'audio',
  acceptsClasses: ['audio', 'video'],
  containers: ['flac'],
  codecs: { audio: ['flac'] },
  traits: {
    animation: 'none',
    alpha: 'none',
    multitrack: false,
    losslessMode: true,
    metadata: true,
  },
  params: [],
  note: 'Lossless compression — but it cannot restore what a lossy source already discarded.',
};

const wav: FormatSpec = {
  id: 'wav',
  label: 'WAV',
  extension: 'wav',
  mime: 'audio/wav',
  family: 'audio',
  acceptsClasses: ['audio', 'video'],
  containers: ['wav'],
  codecs: { audio: ['pcm'] },
  traits: {
    animation: 'none',
    alpha: 'none',
    multitrack: false,
    losslessMode: true,
    metadata: true,
  },
  params: [
    {
      id: 'sampleRate',
      label: 'Sample rate',
      help: 'Changing this resamples the audio.',
      control: 'enum',
      options: [
        { value: 'source', label: 'Match source' },
        { value: '44100', label: '44.1 kHz' },
        { value: '48000', label: '48 kHz' },
      ],
      default: 'source',
      advanced: true,
    },
  ],
  note: 'Uncompressed. Expect a large file.',
};

const ogg: FormatSpec = {
  id: 'ogg',
  label: 'Ogg',
  extension: 'ogg',
  mime: 'audio/ogg',
  family: 'audio',
  acceptsClasses: ['audio', 'video'],
  containers: ['ogg'],
  codecs: { audio: ['vorbis', 'opus', 'flac'] },
  traits: {
    animation: 'none',
    alpha: 'none',
    multitrack: false,
    losslessMode: false,
    metadata: true,
  },
  params: [
    {
      id: 'codec',
      label: 'Audio codec',
      help: 'Opus is the better modern choice and is universally supported.',
      control: 'enum',
      options: [
        { value: 'opus', label: 'Opus (recommended)' },
        { value: 'vorbis', label: 'Vorbis (legacy — needs the fallback engine)' },
      ],
      default: 'opus',
    },
    {
      id: 'bitrate',
      label: 'Bitrate (kbps)',
      control: 'range',
      min: 32,
      max: 320,
      step: 8,
      default: 128,
      advanced: true,
    },
  ],
};

const livePhoto: FormatSpec = {
  id: 'live-photo',
  label: 'Live Photo',
  extension: 'livp',
  mime: 'application/zip',
  family: 'live',
  acceptsClasses: ['live-photo', 'video'],
  containers: ['zip', 'isobmff-mov'],
  codecs: {},
  traits: {
    animation: 'required',
    alpha: 'none',
    multitrack: false,
    losslessMode: false,
    metadata: true,
  },
  params: LIVE_PARAMS,
  note: 'A pair, not a single file: a still image plus a short video sharing an identifier.',
};

export const FORMATS: Record<FormatId, FormatSpec> = {
  jpeg,
  png,
  webp,
  'webp-anim': webpAnim,
  gif,
  apng,
  mp4,
  mov,
  mkv,
  webm,
  'live-photo': livePhoto,
  m4a,
  mp3,
  aac,
  flac,
  wav,
  ogg,
};

export const ALL_FORMAT_IDS = Object.keys(FORMATS) as FormatId[];

export function getFormat(id: FormatId): FormatSpec {
  return FORMATS[id];
}
