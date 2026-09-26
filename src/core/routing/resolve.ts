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

/** Trimmed track sets, so the shape and the loss rules see the same facts. */
function shapeFor(verdict: Verdict): RouteShape {
  switch (verdict.kind) {
    case 'direct':
      return { payload: 'preserved', mediaClass: 'same' };
    case 'project':
      return { payload: 'reencoded', mediaClass: 'changed' };
    case 'impossible':
      return { payload: 'reencoded', mediaClass: 'same' };
  }
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
  const shape = shapeFor(verdict);
  const sourceVideo = profile.videoTracks[0];
  const sourceAudio = profile.audioTracks[0];

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
    ...(profile.otherTrackCount > 0 && !spec.traits.multitrack
      ? { metadataDropped: [] as const }
      : {}),
  });

  const fidelity = computeFidelity({
    shape,
    ...(sourceCodec ? { sourceCodec: sourceCodec as never } : {}),
    ...(targetCodec ? { targetCodec } : {}),
  });

  // A copy is possible when the source codecs fit the target container and no parameter
  // asks for a re-encode. Mirrors the engine's own planning, so the UI can promise
  // "instant and lossless" before the work starts rather than after.
  const wantsReencode =
    params.forceTranscode === true ||
    params.codec !== undefined ||
    params.quality !== undefined ||
    params.bitrate !== undefined;
  const codecsFit = sourceCodec
    ? [...(spec.codecs.video ?? []), ...(spec.codecs.audio ?? [])].includes(sourceCodec as never)
    : false;
  const did = !wantsReencode && codecsFit ? 'transmux' : 'transcode';

  return {
    target,
    feasible: true,
    verdict,
    shape,
    losses,
    fidelity,
    did,
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
