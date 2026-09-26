import type { CodecId, Fidelity, RouteShape } from '../types.ts';
import { isLosslessCodec, severityOf, type LossCode, type LossItem } from './codes.ts';

/** The minimum a loss computation needs to know about the source. */
export interface LossContext {
  shape: RouteShape;
  sourceCodec?: CodecId;
  targetCodec?: CodecId;
  /** Does the source actually carry transparency? Absent/false ⇒ never warn about alpha. */
  sourceHasAlpha?: boolean;
  /** Can the target actually carry transparency? */
  targetSupportsAlpha?: boolean;
  /** How many audio tracks the source has. */
  sourceAudioTracks?: number;
  /** How many audio tracks the target container can hold. */
  targetMaxAudioTracks?: number;
  /** Does the source carry HDR? */
  sourceHasHdr?: boolean;
  /** Did the pipeline bake EXIF orientation into pixels? */
  orientationBaked?: boolean;
  /** Did the source carry metadata the target cannot express? */
  metadataDropped?: readonly LossCode[];
  /** Human-readable size of the source's frame sequence, when relevant. */
  sourceFrameCount?: number;
}

/**
 * The headline verdict.
 *
 * Crucially this is `max(source lossiness, target lossiness)`, not the target alone.
 * Transcoding a lossy source into a lossless container introduces no *new* loss, but it
 * cannot undo the old one — calling that "lossless" without qualification is the kind
 * of technically-true-but-misleading claim this whole module exists to prevent.
 */
export function computeFidelity(ctx: LossContext): Fidelity {
  const { shape } = ctx;

  // A class change outranks payload preservation, mirroring `kindOf()`: a Live Photo
  // split that copies bytes without re-encoding is still a projection, because the
  // user loses half the artifact regardless.
  if (shape.mediaClass === 'changed') return 'projection';
  if (shape.payload === 'preserved') return 'lossless';

  const targetLossless = isLosslessCodec(ctx.targetCodec);
  const sourceLossless = isLosslessCodec(ctx.sourceCodec);

  return targetLossless && sourceLossless ? 'lossless' : 'lossy';
}

/**
 * Compute every loss this specific conversion will incur.
 *
 * Rules are predicates over a real context. Nothing here fires speculatively:
 * a source without alpha produces no alpha warning, and a lossless-to-lossless
 * transcode of a lossless source produces an empty list.
 */
export function computeLosses(ctx: LossContext): LossItem[] {
  const items: LossItem[] = [];
  const add = (code: LossCode, detail?: string) =>
    items.push({ code, severity: severityOf(code), ...(detail ? { detail } : {}) });

  const { shape } = ctx;

  /* --- payload preservation ------------------------------------------- */
  if (shape.payload === 'reencoded') {
    add('requantized');
  }

  /* --- the honesty code ------------------------------------------------- */
  // A lossy source re-encoded into a lossless target gains nothing and gets bigger.
  if (!isLosslessCodec(ctx.sourceCodec) && isLosslessCodec(ctx.targetCodec)) {
    add(
      'generation-loss-from-lossy-source',
      `${label(ctx.targetCodec)} is lossless, but the source already discarded data. ` +
        `The file will be larger with no quality gain.`,
    );
  }

  /* --- transparency ----------------------------------------------------- */
  if (ctx.sourceHasAlpha && ctx.targetSupportsAlpha === false) {
    add(
      'alpha-flattened',
      'Transparency will be composited onto an opaque background. This cannot be undone.',
    );
  }

  /* --- HDR -------------------------------------------------------------- */
  if (ctx.sourceHasHdr) {
    add('hdr-tonemapped', 'High dynamic range will be converted to standard range.');
  }

  /* --- structure -------------------------------------------------------- */
  const srcTracks = ctx.sourceAudioTracks ?? 0;
  const maxTracks = ctx.targetMaxAudioTracks ?? 0;
  if (srcTracks > maxTracks && maxTracks > 0) {
    add('extra-tracks-dropped', `${srcTracks - maxTracks} of ${srcTracks} audio tracks`);
  } else if (srcTracks > 0 && maxTracks === 0) {
    add('extra-tracks-dropped', `all ${srcTracks} audio tracks`);
  }

  if (shape.mediaClass === 'changed') {
    add('frame-selected');
  }

  if (ctx.orientationBaked) {
    add('orientation-baked');
  }

  /* --- metadata --------------------------------------------------------- */
  for (const code of ctx.metadataDropped ?? []) {
    add(code);
  }

  return items;
}

const CODEC_LABELS: Partial<Record<CodecId, string>> = {
  aac: 'AAC',
  alac: 'ALAC',
  av1: 'AV1',
  avc: 'H.264',
  flac: 'FLAC',
  hevc: 'H.265',
  mp3: 'MP3',
  opus: 'Opus',
  pcm: 'PCM',
  prores: 'ProRes',
  vorbis: 'Vorbis',
  vp8: 'VP8',
  vp9: 'VP9',
};

function label(codec: CodecId | undefined): string {
  if (!codec) return 'The target format';
  return CODEC_LABELS[codec] ?? codec;
}

/** True when the user must explicitly acknowledge before we proceed. */
export function requiresAcknowledgement(items: readonly LossItem[]): boolean {
  return items.some((i) => i.severity === 'critical');
}
