import type { CodecId } from '../types.ts';

/**
 * Everything a conversion can cost the user.
 *
 * These are computed against a real probe result and real parameters — never emitted
 * from a static per-format list. A source with no alpha must never see an
 * "alpha will be dropped" warning; warning fatigue is what kills annotation systems.
 */
export type LossCode =
  // --- compression -------------------------------------------------------
  /** Pixels were re-encoded, so this is a generation loss on top of the source. */
  | 'requantized'
  /** Animated image colour was reduced to a palette (GIF/APNG ≤256 colours). */
  | 'quantized-colors'
  /** Chroma subsampling (typically 4:2:0) discarded colour resolution. */
  | 'chroma-subsampled'
  /** Bit depth was reduced, e.g. 10-bit HDR to 8-bit. */
  | 'bit-depth-reduced'
  /** Audio was resampled to a different sample rate. */
  | 'sample-rate-changed'
  /** Multiple audio channels were combined into fewer. */
  | 'channels-downmixed'
  /**
   * The source was already lossy, so a "lossless" target cannot restore it.
   *
   * This is the honesty code most converters omit. MP3 → FLAC is lossless by codec
   * and a lie by content: the file gets bigger and sounds no better.
   */
  | 'generation-loss-from-lossy-source'

  // --- carriage ----------------------------------------------------------
  /** Transparency was composited onto an opaque background. */
  | 'alpha-flattened'
  /** Transparency was removed entirely. */
  | 'alpha-dropped'
  /** HDR was converted to SDR, losing highlight range. */
  | 'hdr-tonemapped'
  /** EXIF orientation was baked into pixels and the tag removed. */
  | 'orientation-baked'

  // --- structure ---------------------------------------------------------
  /** Tracks that the target container cannot hold were removed. */
  | 'extra-tracks-dropped'
  /** A Live Photo's still half was discarded. */
  | 'companion-still-dropped'
  /** A Live Photo's video half was discarded. */
  | 'companion-video-dropped'
  /** Consecutive identical frames were merged. Lossless for the format, but a change. */
  | 'frames-coalesced'
  /** Frame timing was quantised to the target's granularity (GIF: 10 ms). */
  | 'frame-timing-quantized'
  /** Only some of the animation's frames were carried over. */
  | 'frames-dropped'
  /** A single frame was selected out of a moving sequence. */
  | 'frame-selected'
  /**
   * Apple's still-image-time track is absent.
   *
   * It marks where in the video the still sits. Measured on 2026-09-26: its absence
   * does **not** stop Photos from pairing the two halves — taking all three of
   * Apple's metadata tracks out of a working pair left it working. See
   * `docs/researches/live-photo-photos-import.md`. It remains a difference from
   * their output, so it is reported; it is not why a pair fails to pair.
   */
  | 'still-image-time-track-missing'
  /**
   * The pairing identifier is in the movie but not in the still.
   *
   * Apple pairs the two halves by an identifier both must carry: the still keeps its copy
   * in its maker notes, the movie in QuickTime metadata. A still that already carries EXIF
   * cannot be given one without rewriting that EXIF, so it is carried across as it is —
   * and the two halves will import as separate items rather than one Live Photo.
   */
  | 'pairing-identifier-not-written'

  // --- metadata ----------------------------------------------------------
  | 'metadata-exif-dropped'
  | 'metadata-xmp-dropped'
  | 'metadata-icc-dropped'
  /** Colour was reinterpreted as sRGB because no ICC profile survived. */
  | 'metadata-icc-assumed-srgb'
  /** GPS location was removed. Always an explicit, visible choice. */
  | 'metadata-gps-stripped'
  /** Container-level keys the target cannot express were dropped. */
  | 'metadata-container-keys-dropped';

export type LossSeverity = 'info' | 'warn' | 'critical';

export interface LossItem {
  code: LossCode;
  severity: LossSeverity;
  /** Computed, specific detail — e.g. "3 of 5 audio tracks". */
  detail?: string;
}

/**
 * Default severity per code.
 *
 * `critical` gates the Convert button behind an explicit acknowledgement, so it is
 * reserved for irreversible losses the user would be upset to discover afterwards.
 */
const SEVERITY: Record<LossCode, LossSeverity> = {
  requantized: 'info',
  'quantized-colors': 'warn',
  'chroma-subsampled': 'info',
  'bit-depth-reduced': 'warn',
  'sample-rate-changed': 'warn',
  'channels-downmixed': 'warn',
  'generation-loss-from-lossy-source': 'info',

  'alpha-flattened': 'critical',
  'alpha-dropped': 'critical',
  'hdr-tonemapped': 'critical',
  'orientation-baked': 'info',

  'extra-tracks-dropped': 'warn',
  'companion-still-dropped': 'warn',
  'companion-video-dropped': 'warn',
  'frames-coalesced': 'info',
  'frame-timing-quantized': 'info',
  'frames-dropped': 'warn',
  'frame-selected': 'warn',
  'still-image-time-track-missing': 'info',
  'pairing-identifier-not-written': 'warn',

  'metadata-exif-dropped': 'warn',
  'metadata-xmp-dropped': 'warn',
  'metadata-icc-dropped': 'warn',
  'metadata-icc-assumed-srgb': 'warn',
  'metadata-gps-stripped': 'critical',
  'metadata-container-keys-dropped': 'info',
};

export function severityOf(code: LossCode): LossSeverity {
  return SEVERITY[code];
}

/** Codecs that are lossless by construction. Everything else loses data on encode. */
const LOSSLESS_CODECS: ReadonlySet<CodecId> = new Set<CodecId>([
  'flac',
  'alac',
  'pcm',
  'prores',
]);

export function isLosslessCodec(codec: CodecId | undefined): boolean {
  return codec !== undefined && LOSSLESS_CODECS.has(codec);
}
