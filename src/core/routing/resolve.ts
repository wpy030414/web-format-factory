import { computeFidelity, computeLosses, requiresAcknowledgement } from '../loss/fidelity.ts';
import type { LossItem } from '../loss/codes.ts';
import { getFormat } from '../registry/formats.ts';
import type { MediaProfile } from '../probe/profile.ts';
import type { Fidelity, FormatId, RouteShape } from '../types.ts';
import { IMPOSSIBILITY_COPY, type Impossibility } from './impossibility.ts';
import { alternativesFor, verdictFor, type Verdict } from './transitions.ts';
import { ALL_FORMAT_IDS, FORMATS } from '../registry/formats.ts';

/** A concrete plan for one file → one target, ready for the UI to render and confirm. */
export interface ResolvedPlan {
  target: FormatId;
  feasible: boolean;
  verdict: Verdict;
  /** Present when `feasible` is false. */
  impossibility?: Impossibility;
  shape?: RouteShape;
  losses: LossItem[];
  fidelity?: Fidelity;
  /** The user must tick a box before Convert unlocks. */
  needsAcknowledgement: boolean;
  /** Whether the work will be a pure container change or a re-encode. */
  did?: 'transmux' | 'transcode';
}

/**
 * Decide whether the encoded data can actually be carried over untouched.
 *
 * This is NOT the same question as "does the target accept this media class". A `direct`
 * verdict only means the target can hold this *kind* of content; MP3 into an M4A target
 * is perfectly direct and yet PCM-free AAC cannot store MP3 frames, so the payload has
 * to be re-encoded. Treating `direct` as "lossless" would tell the user a lossy
 * conversion costs nothing — the exact lie this project exists to avoid.
 *
 * Every source codec must fit, not just the first: a video whose picture codec suits the
 * target but whose audio codec does not still has to be re-encoded.
 */
function canCopyPayload(
  profile: MediaProfile,
  target: FormatId,
  params: Readonly<Record<string, unknown>>,
): boolean {
  const spec = getFormat(target);
  const supported = [...(spec.codecs.video ?? []), ...(spec.codecs.audio ?? [])] as string[];
  if (supported.length === 0) return false; // image targets copy via other engines

  const userForced =
    params.forceTranscode === true ||
    params.codec !== undefined ||
    params.quality !== undefined ||
    params.bitrate !== undefined;
  if (userForced) return false;

  const sourceCodecs = [
    ...profile.videoTracks.map((t) => t.codec),
    ...profile.audioTracks.map((t) => t.codec),
  ];
  if (sourceCodecs.length === 0) return false;

  return sourceCodecs.every((codec) => supported.includes(codec));
}

/**
 * Work out everything the user should know before they press Convert.
 *
 * This is where the routing table and the loss model meet: the verdict decides *whether*
 * the conversion can happen, the profile decides *what it costs*, and both are computed
 * from real facts rather than a static per-format list.
 */
export function planFor(
  profile: MediaProfile,
  target: FormatId,
  params: Readonly<Record<string, unknown>> = {},
): ResolvedPlan {
  const verdict = verdictFor(profile.mediaClass, target);

  if (verdict.kind === 'impossible') {
    return {
      target,
      feasible: false,
      verdict,
      impossibility: {
        reason: verdict.reason,
        ...(verdict.reason === 'no-encoder-in-browser' && profile.videoTracks[0]
          ? { detail: profile.videoTracks[0].codec.toUpperCase() }
          : {}),
        alternatives: alternativesFor(profile.mediaClass, ALL_FORMAT_IDS),
      },
      losses: [],
      needsAcknowledgement: false,
    };
  }

  const spec = getFormat(target);
  const sourceVideo = profile.videoTracks[0];
  const sourceAudio = profile.audioTracks[0];

  // Whether the bytes survive decides both the honesty verdict and the speed badge, so
  // it is derived from codec compatibility — never assumed from the verdict kind.
  const copyable = verdict.kind === 'direct' && canCopyPayload(profile, target, params);
  const shape: RouteShape = {
    payload: copyable ? 'preserved' : 'reencoded',
    mediaClass: verdict.kind === 'project' ? 'changed' : 'same',
  };

  // Which codec will the output carry? For a copy it is the source's; for a re-encode
  // it is whatever the target's default is. This drives the lossless-vs-lossy verdict.
  const targetCodec = spec.codecs.video?.[0] ?? spec.codecs.audio?.[0];
  const sourceCodec = sourceVideo?.codec ?? sourceAudio?.codec;

  const losses = computeLosses({
    shape,
    ...(sourceCodec ? { sourceCodec: sourceCodec as never } : {}),
    ...(targetCodec ? { targetCodec } : {}),
    sourceHasAlpha: profile.hasAlpha === true,
    targetSupportsAlpha: spec.traits.alpha !== 'none',
    sourceAudioTracks: profile.audioTracks.length,
    targetMaxAudioTracks: spec.traits.multitrack ? 8 : profile.audioTracks.length > 0 ? 1 : 0,
  });

  const fidelity = computeFidelity({
    shape,
    ...(sourceCodec ? { sourceCodec: sourceCodec as never } : {}),
    ...(targetCodec ? { targetCodec } : {}),
  });

  return {
    target,
    feasible: true,
    verdict,
    shape,
    losses,
    fidelity,
    did: copyable ? 'transmux' : 'transcode',
    needsAcknowledgement: requiresAcknowledgement(losses),
  };
}

/** Convenience: plans for every target, used to render the picker. */
export function planAllTargets(
  profile: MediaProfile,
  params: Readonly<Record<string, unknown>> = {},
): ResolvedPlan[] {
  return ALL_FORMAT_IDS.map((t) => planFor(profile, t, params));
}

export { IMPOSSIBILITY_COPY, FORMATS };
