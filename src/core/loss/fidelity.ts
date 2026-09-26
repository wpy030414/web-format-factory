import type { CodecId, Fidelity, RouteShape } from '../types.ts';
import type { FrameTiming } from '../registry/formats.ts';
import type { FrameRateFacts } from '../probe/profile.ts';
import { isLosslessCodec, severityOf, type LossCode, type LossItem } from './codes.ts';

/** The minimum a loss computation needs to know about the source. */
export interface LossContext {
  shape: RouteShape;
  sourceCodec?: CodecId;
  targetCodec?: CodecId;
  /**
   * Explicit losslessness when it is not codec-derived.
   *
   * Image formats have no codec field: PNG is lossless by construction, JPEG is lossy
   * by construction, and neither fact is expressible as a `CodecId`. Without these
   * overrides every image conversion would be reported as lossy, including PNG → PNG.
   */
  sourceLossless?: boolean;
  targetLossless?: boolean;
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
  /** Display name of the target, for messages when there is no codec to name. */
  targetLabel?: string;
  /** Did the source carry metadata the target cannot express? */
  metadataDropped?: readonly LossCode[];
  /** Human-readable size of the source's frame sequence, when relevant. */
  sourceFrameCount?: number;
  /**
   * What the target can do with frame timing, when it cannot hold the source's.
   *
   * Absent for a video container, which carries exact timestamps and therefore loses no
   * timing at all — and absent is not "no constraint", it is "no rule applies here".
   */
  targetFrameTiming?: FrameTiming;
  /**
   * How fast the source runs, when it could be measured.
   *
   * Absent means the measurement did not happen. Both frame-timing rules below are silent
   * then, because a warning derived from an assumed frame rate is a warning about a file
   * it may have nothing to do with.
   */
  sourceFrameRate?: FrameRateFacts;
  /**
   * Does this conversion pick a single frame out of a moving sequence?
   *
   * Not the same as a class change, which is what this used to be inferred from: video →
   * GIF changes class and carries every frame over, while a class change to a still image
   * is the case that really does take one.
   */
  selectsSingleFrame?: boolean;
}

/** Whether the source discarded data, from a codec or an explicit override. */
function sourceIsLossless(ctx: LossContext): boolean {
  return ctx.sourceLossless ?? isLosslessCodec(ctx.sourceCodec);
}

function targetIsLossless(ctx: LossContext): boolean {
  return ctx.targetLossless ?? isLosslessCodec(ctx.targetCodec);
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

  return targetIsLossless(ctx) && sourceIsLossless(ctx) ? 'lossless' : 'lossy';
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
  if (!sourceIsLossless(ctx) && targetIsLossless(ctx)) {
    add(
      'generation-loss-from-lossy-source',
      `${label(ctx.targetCodec, ctx.targetLabel)}是无损的，但源文件已经丢过数据了。` +
        `文件会更大，音质或画质不会变好。`,
    );
  }

  /* --- transparency ----------------------------------------------------- */
  if (ctx.sourceHasAlpha && ctx.targetSupportsAlpha === false) {
    add(
      'alpha-flattened',
      '透明区域会被叠到白色背景上，此操作不可撤销。',
    );
  }

  /* --- HDR -------------------------------------------------------------- */
  if (ctx.sourceHasHdr) {
    add('hdr-tonemapped', '高动态范围会被压缩为普通范围。');
  }

  /* --- structure -------------------------------------------------------- */
  const srcTracks = ctx.sourceAudioTracks ?? 0;
  const maxTracks = ctx.targetMaxAudioTracks ?? 0;
  if (srcTracks > maxTracks && maxTracks > 0) {
    add('extra-tracks-dropped', `${srcTracks} 条音轨中的 ${srcTracks - maxTracks} 条`);
  } else if (srcTracks > 0 && maxTracks === 0) {
    add('extra-tracks-dropped', `全部 ${srcTracks} 条音轨`);
  }

  /* --- frame timing ----------------------------------------------------- */
  // What a format with no exact timing of its own does to the source's. Fires only when
  // the target declares a timing model *and* the source's rate was actually measured —
  // see the two fields on `LossContext`.
  const timing = ctx.targetFrameTiming;
  const rate = ctx.sourceFrameRate;
  if (timing && rate && rate.average > 0) {
    if (rate.max > 1000 / timing.floorMs) {
      // Conforming a source to what the target can hold is a loss, not an edit — nobody
      // chose a frame rate here. Everything that survives lands on the grid, so this
      // replaces the quantisation warning rather than arriving alongside it.
      add(
        'frames-dropped',
        `源最高约 ${Math.round(rate.max)} fps，超过该格式能如实播放的 ${Math.floor(1000 / timing.floorMs)} fps`,
      );
    } else if (!rate.constant || !onGrid(1000 / rate.average, timing.gridMs)) {
      add('frame-timing-quantized', `源帧间隔约 ${round1(1000 / rate.average)} 毫秒`);
    }
  }

  if (ctx.selectsSingleFrame) {
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

/**
 * Is `value` a whole number of `step`s?
 *
 * Compared with a tolerance rather than exactly: these are frame rates, and 1000/30 is
 * never going to be a tidy decimal. A sixth of a millisecond either way is not a loss.
 */
function onGrid(value: number, step: number): boolean {
  const steps = value / step;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

/** One decimal place — more precision than a message about a frame interval deserves. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
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

function label(codec: CodecId | undefined, fallback?: string): string {
  if (codec) return CODEC_LABELS[codec] ?? codec;
  return fallback ?? '目标格式';
}

/** True when the user must explicitly acknowledge before we proceed. */
export function requiresAcknowledgement(items: readonly LossItem[]): boolean {
  return items.some((i) => i.severity === 'critical');
}
