import { computeFidelity, computeLosses, requiresAcknowledgement } from '../loss/fidelity.ts';
import type { LossItem } from '../loss/codes.ts';
import { changedParams, getFormat } from '../registry/formats.ts';
import type { MediaProfile } from '../probe/profile.ts';
import type { ContainerId, Fidelity, FormatId, RouteShape } from '../types.ts';
import { IMPOSSIBILITY_COPY, type Impossibility } from './impossibility.ts';
import { alternativesFor, verdictFor, type Verdict } from './transitions.ts';
import { shutGate, type RouteCapabilities } from './gates.ts';
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

  // Only what the user actually changed counts. A seeded default is present in the
  // parameter set but represents no decision, and reading it as one would mark every
  // untouched conversion as a re-encode.
  const chosen = changedParams(target, params);
  const userForced =
    chosen.forceTranscode === true ||
    chosen.codec !== undefined ||
    chosen.quality !== undefined ||
    chosen.bitrate !== undefined;
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
 *
 * `caps` is what this machine can run, and it is required rather than defaulted. A default
 * would have to be either the optimistic answer — offering routes that then fail — or the
 * pessimistic one, hiding routes that work; neither is a decision this function is
 * entitled to make on the caller's behalf.
 */
export function planFor(
  profile: MediaProfile,
  target: FormatId,
  caps: RouteCapabilities,
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

  // Whether the encoded bytes survive untouched decides the honesty verdict, the speed
  // badge, and which of the machine's doors apply — so it is settled up front, from codec
  // compatibility, and never assumed from the verdict kind.
  const copyable = verdict.kind === 'direct' && canCopyPayload(profile, target, params);

  // Semantically fine, but not on this machine.
  //
  // Applied here rather than inside `verdictFor()` so that function stays a statement
  // about what is *possible*, identical on every browser — which is what makes its
  // exhaustive snapshot test mean anything. This is the layer that answers "possible
  // here", and the difference is the whole point: a route that is offered and then fails
  // at the end of the job teaches the user nothing, while a disabled button carrying a
  // reason teaches them what to do about it.
  const shut = shutGate({ profile, target, params, caps, verdict, copyable });
  if (shut) {
    return {
      target,
      feasible: false,
      verdict: { kind: 'impossible', reason: shut.reason },
      impossibility: {
        reason: shut.reason,
        detail: shut.detail,
        alternatives: alternativesFor(profile.mediaClass, ALL_FORMAT_IDS),
      },
      losses: [],
      needsAcknowledgement: false,
    };
  }

  const spec = getFormat(target);
  const sourceVideo = profile.videoTracks[0];
  const sourceAudio = profile.audioTracks[0];

  const shape: RouteShape = {
    payload: copyable ? 'preserved' : 'reencoded',
    mediaClass: verdict.kind === 'project' ? 'changed' : 'same',
  };

  // Which codec will the output carry? For a copy it is the source's; for a re-encode
  // it is whatever the target's default is. This drives the lossless-vs-lossy verdict.
  const targetCodec = spec.codecs.video?.[0] ?? spec.codecs.audio?.[0];
  const sourceCodec = sourceVideo?.codec ?? sourceAudio?.codec;

  // Image formats carry no codec field, so their losslessness comes from the format's
  // own traits: PNG preserves every sample, JPEG discards some by construction.
  const sourceLossless = sourceCodec ? undefined : sourceContainerIsLossless(profile.container);
  const targetLossless = targetCodec ? undefined : spec.traits.losslessMode;

  const losses = computeLosses({
    shape,
    ...(sourceCodec ? { sourceCodec: sourceCodec as never } : {}),
    ...(targetCodec ? { targetCodec } : {}),
    ...(sourceLossless !== undefined ? { sourceLossless } : {}),
    ...(targetLossless !== undefined ? { targetLossless } : {}),
    targetLabel: spec.label,
    sourceHasAlpha: profile.hasAlpha === true,
    targetSupportsAlpha: spec.traits.alpha !== 'none',
    sourceAudioTracks: profile.audioTracks.length,
    targetMaxAudioTracks: spec.traits.multitrack ? 8 : profile.audioTracks.length > 0 ? 1 : 0,
  });

  const fidelity = computeFidelity({
    shape,
    ...(sourceCodec ? { sourceCodec: sourceCodec as never } : {}),
    ...(targetCodec ? { targetCodec } : {}),
    ...(sourceLossless !== undefined ? { sourceLossless } : {}),
    ...(targetLossless !== undefined ? { targetLossless } : {}),
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

/**
 * Losslessness of a *source* container, for the formats that carry no codec.
 *
 * Only images are in this position. PNG (and therefore APNG) preserves every sample;
 * JPEG, GIF and WebP all discard some by construction at their default settings.
 */
function sourceContainerIsLossless(container: ContainerId | 'unknown'): boolean {
  return container === 'png';
}

/** Convenience: plans for every target, used to render the picker. */
export function planAllTargets(
  profile: MediaProfile,
  caps: RouteCapabilities,
  params: Readonly<Record<string, unknown>> = {},
): ResolvedPlan[] {
  return ALL_FORMAT_IDS.map((t) => planFor(profile, t, caps, params));
}

export { IMPOSSIBILITY_COPY, FORMATS };
