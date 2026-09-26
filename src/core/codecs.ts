import type { CodecId } from './types.ts';

/**
 * The codec vocabulary: our ids, the strings the browser knows them by, and what to call
 * them in front of a person.
 *
 * One table rather than one per consumer. It had already drifted into two — the
 * diagnostic page keyed its probes by display name while the rest of the app spoke codec
 * ids — and a third copy was about to appear in the routing layer. Two tables of codec
 * strings is two things to keep in step, and the failure mode of drift here is a route
 * judged against the wrong codec.
 *
 * `webcodecs` is absent for the codecs WebCodecs has no name for, which is not an
 * oversight: PCM is written by the media library itself and ALAC has no encoder anywhere.
 */
export interface CodecProfile {
  /** What a person calls it. */
  label: string;
  /** The codec string `isConfigSupported` expects, where the browser has one. */
  webcodecs?: string;
}

export const CODECS: Partial<Record<CodecId, CodecProfile>> = {
  // Suffixed profiles are deliberate: a bare `'avc1'` or `'h264'` is rejected outright,
  // and a probe written with the short name reports H.264 as missing on a machine that
  // encodes it perfectly well. These are Main profile level 3.1 and 5.2.
  avc: { label: 'H.264', webcodecs: 'avc1.42001f' },
  hevc: { label: 'H.265', webcodecs: 'hvc1.1.6.L93.B0' },
  vp8: { label: 'VP8', webcodecs: 'vp8' },
  vp9: { label: 'VP9', webcodecs: 'vp09.00.10.08' },
  av1: { label: 'AV1', webcodecs: 'av01.0.05M.08' },

  aac: { label: 'AAC', webcodecs: 'mp4a.40.2' },
  opus: { label: 'Opus', webcodecs: 'opus' },
  mp3: { label: 'MP3', webcodecs: 'mp3' },
  flac: { label: 'FLAC', webcodecs: 'flac' },
  vorbis: { label: 'Vorbis', webcodecs: 'vorbis' },

  // Written by the media library or the fallback engine rather than by WebCodecs.
  pcm: { label: 'PCM' },
  alac: { label: 'ALAC' },

  // Picture codecs that never reach a browser encoder at all.
  prores: { label: 'ProRes' },
  'gif-lzw': { label: 'GIF' },
  'webp-vp8': { label: 'WebP' },
};

/**
 * Audio codecs with no encoder in any browser, supplied here as a WASM package instead.
 *
 * The list lives in this light module rather than only beside the downloaders, because
 * routing has to know that "the browser cannot encode MP3" does not mean "this app cannot
 * produce MP3" — asking only the browser would disable three targets that work.
 */
export const WASM_ENCODED_CODECS = ['mp3', 'flac', 'aac'] as const;

/** One of the codecs a package supplies. */
export type WasmEncodedCodec = (typeof WASM_ENCODED_CODECS)[number];

/** The video codecs worth asking the browser about, in the order a UI should list them. */
export const PROBED_VIDEO_CODECS: readonly CodecId[] = ['avc', 'hevc', 'vp8', 'vp9', 'av1'];

/** The audio ones. MP3, FLAC and AAC are here even though WebCodecs refuses all three
 *  on every platform — the answer is what tells us an extension package is needed. */
export const PROBED_AUDIO_CODECS: readonly CodecId[] = ['aac', 'opus', 'mp3', 'flac', 'vorbis'];

/**
 * A codec's display name.
 *
 * Falls back to the raw id upper-cased rather than to a placeholder: a codec we have not
 * catalogued is still better named by its own id than by "未知编码", which would tell the
 * user nothing and hide the gap from us.
 */
export function codecLabel(id: string): string {
  return CODECS[id as CodecId]?.label ?? id.toUpperCase();
}
