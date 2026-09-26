import type { FormatId, ImpossibilityReason, MediaClass } from '../types.ts';
import { getFormat } from '../registry/formats.ts';

/** A way of moving content between media classes. */
export type ProjectorId =
  /** Frames → animation frames. */
  | 'animate'
  /** Pick the representative still out of a moving sequence. */
  | 'keyframe'
  /** Lift an audio track out of a container and drop the pictures. */
  | 'demux-audio'
  /** Take the video half of a Live Photo. */
  | 'split-video'
  /** Take the still half of a Live Photo. */
  | 'split-still'
  /** Re-package the two halves under a new identifier/flavour. */
  | 'repack-live';

export type Verdict =
  | { kind: 'direct' }
  | { kind: 'project'; projector: ProjectorId }
  | { kind: 'impossible'; reason: ImpossibilityReason };

/**
 * Explicit verdicts for class transitions that are NOT covered by a target's
 * `acceptsClasses`.
 *
 * Only possible-and-impossible *exceptions* live here; everything else falls through
 * to the derived rules in `verdictFor()`. That keeps this table small enough to read
 * in one sitting while still being the single authority on what is allowed.
 */
const TRANSITIONS: Partial<Record<MediaClass, Partial<Record<FormatId, Verdict>>>> = {
  /* ---- video ---------------------------------------------------------- */
  video: {
    gif: { kind: 'project', projector: 'animate' },
    'webp-anim': { kind: 'project', projector: 'animate' },
    apng: { kind: 'project', projector: 'animate' },
    jpeg: { kind: 'project', projector: 'keyframe' },
    png: { kind: 'project', projector: 'keyframe' },
    webp: { kind: 'project', projector: 'keyframe' },
    'live-photo': { kind: 'project', projector: 'repack-live' },
    'motion-photo': { kind: 'project', projector: 'repack-live' },
  },

  /* ---- animated image -------------------------------------------------- */
  'animated-image': {
    jpeg: { kind: 'project', projector: 'keyframe' },
    webp: { kind: 'project', projector: 'keyframe' },
    png: { kind: 'project', projector: 'keyframe' },
    'live-photo': { kind: 'impossible', reason: 'needs-motion-component' },
    'motion-photo': { kind: 'impossible', reason: 'needs-motion-component' },
  },

  /* ---- still image ----------------------------------------------------- */
  'still-image': {
    gif: { kind: 'impossible', reason: 'needs-multiple-frames' },
    'webp-anim': { kind: 'impossible', reason: 'needs-multiple-frames' },
    apng: { kind: 'impossible', reason: 'needs-multiple-frames' },
    mp4: { kind: 'impossible', reason: 'needs-motion-component' },
    mov: { kind: 'impossible', reason: 'needs-motion-component' },
    mkv: { kind: 'impossible', reason: 'needs-motion-component' },
    webm: { kind: 'impossible', reason: 'needs-motion-component' },
    'live-photo': { kind: 'impossible', reason: 'livephoto-needs-video' },
    'motion-photo': { kind: 'impossible', reason: 'livephoto-needs-video' },
  },

  /* ---- audio ----------------------------------------------------------- */
  audio: {
    mp4: { kind: 'impossible', reason: 'needs-visual-component' },
    mov: { kind: 'impossible', reason: 'needs-visual-component' },
    mkv: { kind: 'impossible', reason: 'needs-visual-component' },
    webm: { kind: 'impossible', reason: 'needs-visual-component' },
    gif: { kind: 'impossible', reason: 'needs-visual-component' },
    'webp-anim': { kind: 'impossible', reason: 'needs-visual-component' },
    apng: { kind: 'impossible', reason: 'needs-visual-component' },
    jpeg: { kind: 'impossible', reason: 'class-mismatch' },
    png: { kind: 'impossible', reason: 'class-mismatch' },
    webp: { kind: 'impossible', reason: 'class-mismatch' },
    'live-photo': { kind: 'impossible', reason: 'class-mismatch' },
    'motion-photo': { kind: 'impossible', reason: 'class-mismatch' },
  },

  /* ---- live photo ------------------------------------------------------ */
  'live-photo': {
    mp4: { kind: 'project', projector: 'split-video' },
    mov: { kind: 'project', projector: 'split-video' },
    mkv: { kind: 'project', projector: 'split-video' },
    webm: { kind: 'project', projector: 'split-video' },
    gif: { kind: 'project', projector: 'split-video' },
    'webp-anim': { kind: 'project', projector: 'split-video' },
    apng: { kind: 'project', projector: 'split-video' },
    jpeg: { kind: 'project', projector: 'split-still' },
    png: { kind: 'project', projector: 'split-still' },
    webp: { kind: 'project', projector: 'split-still' },
    'live-photo': { kind: 'project', projector: 'repack-live' },
    'motion-photo': { kind: 'project', projector: 'repack-live' },
  },
};

/**
 * Resolve the verdict for a (source class → target format) pair.
 *
 * Order of authority:
 *   1. an explicit exception in TRANSITIONS
 *   2. the target declaring it accepts this class directly
 *   3. a derived impossibility
 *
 * Deriving the fallback (rather than tabulating all 100+ pairs) keeps the authored
 * data small, but it must stay *exhaustive*: the unit tests enumerate every pair and
 * snapshot the result, so a gap in the rules shows up as a failing test rather than a
 * silently disabled button.
 */
export function verdictFor(source: MediaClass, target: FormatId): Verdict {
  const explicit = TRANSITIONS[source]?.[target];
  if (explicit) return explicit;

  const spec = getFormat(target);
  if (spec.acceptsClasses.includes(source)) return { kind: 'direct' };

  return { kind: 'impossible', reason: deriveReason(source, spec.family) };
}

function deriveReason(source: MediaClass, family: string): ImpossibilityReason {
  if (source === 'unknown') return 'class-mismatch';
  if (family === 'video' || family === 'live') return 'needs-visual-component';
  if (family === 'audio') return 'class-mismatch';
  if (family === 'image') {
    return source === 'audio' ? 'class-mismatch' : 'needs-multiple-frames';
  }
  return 'class-mismatch';
}

/** Formats a user could sensibly pick instead, given what they actually dropped in. */
export function alternativesFor(source: MediaClass, all: readonly FormatId[]): FormatId[] {
  return all.filter((f) => verdictFor(source, f).kind !== 'impossible');
}
