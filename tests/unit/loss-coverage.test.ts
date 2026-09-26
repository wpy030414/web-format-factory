import { describe, expect, it } from 'vitest';

import { LOSS_CODES, type LossCode } from '@/core/loss/codes.ts';
import type { MediaProfile } from '@/core/probe/profile.ts';
import { ALL_FORMAT_IDS } from '@/core/registry/formats.ts';
import { planFor, planAllTargets } from '@/core/routing/resolve.ts';
import type { RouteCapabilities } from '@/core/routing/gates.ts';
import type { CodecId } from '@/core/types.ts';

/**
 * Every loss code has a producer, or is on the list of the ones that do not.
 *
 * The failure this guards against is quiet and specific: `frame-timing-quantized` was
 * defined, given a severity, given copy in the UI — and emitted by nothing at all, for as
 * long as it existed. A code nothing produces cannot be caught by the type system, cannot
 * be caught by a rendering test, and shows up to the user as a promise the app never keeps.
 * It also cannot be noticed by reading the code, because the definition is right there and
 * looks like the feature exists.
 *
 * So the state is asserted rather than assumed, in both directions: a code that gains a
 * producer must leave this list, and a code that has none must join it. Either way the
 * table below has to be edited on purpose, with a reason.
 */

const CAPS: RouteCapabilities = {
  imageDecoder: true,
  crossOriginIsolated: true,
  encodable: new Set<CodecId>(['avc', 'hevc', 'vp8', 'vp9', 'av1', 'aac', 'opus', 'mp3', 'flac']),
};

/**
 * Sources chosen so that every rule with a condition has something to fire on.
 *
 * Deliberately contrived — a 60 fps video with an alpha channel is not a normal file — but
 * the question here is *reachability*: which rules exist at all, not which ones a typical
 * user meets.
 */
const SOURCES: MediaProfile[] = [
  profile('video', { video: ['avc'], audio: ['aac'], frameRate: { average: 30, max: 30, constant: true } }),
  profile('video', { video: ['avc'], audio: ['aac'], frameRate: { average: 60, max: 60, constant: true } }),
  // Variable frame rate: the grid cannot be proven, so the quantisation rule fires.
  profile('video', { video: ['avc'], audio: ['aac'], frameRate: { average: 24, max: 60, constant: false } }),
  // No measurement at all, which must stay silent rather than guess.
  profile('video', { video: ['avc'], audio: ['aac'] }),
  profile('video', { video: ['vp9'], audio: ['opus'], hasAlpha: true, container: 'matroska' }),
  profile('video', { video: ['avc'], audio: ['aac', 'aac'] }),
  profile('animated-image', { container: 'gif', hasAlpha: true }),
  profile('still-image', { container: 'png', hasAlpha: true }),
  profile('still-image', { container: 'jpeg' }),
  profile('audio', { container: 'isobmff-m4a', audio: ['aac'] }),
  profile('live-photo', { container: 'jpeg', video: ['avc'], audio: ['aac'], contentId: 'x' }),
];

function profile(
  mediaClass: MediaProfile['mediaClass'],
  opts: {
    container?: MediaProfile['container'];
    video?: string[];
    audio?: string[];
    hasAlpha?: boolean;
    frameRate?: MediaProfile['videoTracks'][number]['frameRate'];
    contentId?: string;
  } = {},
): MediaProfile {
  return {
    name: 'x',
    size: 1,
    container: opts.container ?? 'isobmff-mp4',
    mediaClass,
    videoTracks: (opts.video ?? []).map((codec) => ({
      codec,
      width: 1920,
      height: 1080,
      decodable: true,
      ...(opts.frameRate ? { frameRate: opts.frameRate } : {}),
    })),
    audioTracks: (opts.audio ?? []).map((codec) => ({
      codec,
      channels: 2,
      sampleRate: 44100,
      decodable: true,
    })),
    otherTrackCount: 0,
    ...(opts.hasAlpha !== undefined ? { hasAlpha: opts.hasAlpha } : {}),
    ...(opts.contentId ? { contentId: opts.contentId } : {}),
  };
}

function producedCodes(): Set<LossCode> {
  const seen = new Set<LossCode>();
  for (const source of SOURCES) {
    for (const plan of planAllTargets(source, CAPS)) {
      for (const item of plan.losses) seen.add(item.code);
    }
  }
  return seen;
}

/**
 * Codes no plan produces, and why. Two groups, and only the second is a gap.
 *
 * 1. Reported by an engine *after* the conversion rather than predicted before it. A plan
 *    describes what the user is about to get; these describe what the pipeline found when
 *    it got there, and they travel as `EngineResult.extraLosses`.
 * 2. No rule, or a rule no caller can reach yet. These are the honest gaps, and the list
 *    is here so that the next person adding a rule can see what is missing instead of
 *    assuming the set is complete.
 */
const NOT_FROM_A_PLAN: readonly LossCode[] = [
  /* — reported by an engine, after the fact — */
  'companion-still-dropped',
  'companion-video-dropped',
  'pairing-identifier-not-written',
  'still-image-time-track-missing',

  /* — no rule yet — */
  // Nothing measures colour counts, chroma subsampling or bit depth, so a re-encode is
  // reported as a re-encode and nothing more.
  'quantized-colors',
  'chroma-subsampled',
  'bit-depth-reduced',
  // Audio is carried whole or dropped whole; nothing resamples or downmixes.
  'sample-rate-changed',
  'channels-downmixed',
  // Transparency is flattened (which is reported) or kept; nothing removes the channel.
  'alpha-dropped',
  // The encoder does not merge identical frames, so this has no producer and no prospect
  // of one until it does.
  'frames-coalesced',
  // Whether metadata survives is settled inside the engines, which is where it is said.
  'metadata-exif-dropped',
  'metadata-xmp-dropped',
  'metadata-icc-dropped',
  'metadata-icc-assumed-srgb',
  'metadata-gps-stripped',
  'metadata-container-keys-dropped',
  // Rules that exist, with no caller that can reach them: nothing sets `orientationBaked`
  // or `sourceHasHdr`, because the probe detects neither yet.
  'orientation-baked',
  'hdr-tonemapped',
];

describe('loss coverage — 每个定义了的损失码都得有人发', () => {
  it('计划期算不出来的损失码，正好就是记录在案的那些', () => {
    const produced = producedCodes();
    const unproduced = LOSS_CODES.filter((code) => !produced.has(code)).sort();
    expect(unproduced).toEqual([...NOT_FROM_A_PLAN].sort());
  });

  it('帧时序的三条规则确实会各自触发，而不是只存在于定义里', () => {
    const dropped = planFor(
      SOURCES[1] as MediaProfile,
      'gif',
      CAPS,
    ).losses.map((item) => item.code);
    expect(dropped).toContain('frames-dropped');

    const quantized = planFor(SOURCES[0] as MediaProfile, 'gif', CAPS).losses.map((i) => i.code);
    expect(quantized).toContain('frame-timing-quantized');

    // A rate of exactly 25 fps lands on the 10 ms grid with nothing left over, and a
    // constant one needs no conforming — so a 25 fps GIF conversion loses no timing and
    // must not say that it does.
    const onGrid = profile('video', {
      video: ['avc'],
      frameRate: { average: 25, max: 25, constant: true },
    });
    const codes = planFor(onGrid, 'gif', CAPS).losses.map((i) => i.code);
    expect(codes).not.toContain('frame-timing-quantized');
    expect(codes).not.toContain('frames-dropped');
  });

  it('视频转 GIF 不是「取一帧」——那条投影警告属于静图目标', () => {
    const video = SOURCES[0] as MediaProfile;
    const toGif = planFor(video, 'gif', CAPS);
    expect(toGif.losses.map((i) => i.code)).not.toContain('frame-selected');

    // The animated → still projection still selects one, and still says so.
    const fromAnimation = planFor(SOURCES[6] as MediaProfile, 'jpeg', CAPS);
    expect(fromAnimation.losses.map((i) => i.code)).toContain('frame-selected');
  });

  it('图片目标装不下音轨，这件事必须说出来', () => {
    // The plan used to read "not multitrack, but the source has audio" as room for one
    // track — so a video with a soundtrack became a silent GIF without a word.
    const video = SOURCES[0] as MediaProfile;
    expect(planFor(video, 'gif', CAPS).losses.map((i) => i.code)).toContain('extra-tracks-dropped');

    // A video container keeps it, so nothing is claimed there.
    expect(planFor(video, 'mkv', CAPS).losses.map((i) => i.code)).not.toContain(
      'extra-tracks-dropped',
    );
  });

  it('每个目标的损失都算得出来，没有哪个目标是靠抛异常得出结论的', () => {
    for (const source of SOURCES) {
      expect(() => ALL_FORMAT_IDS.map((t) => planFor(source, t, CAPS))).not.toThrow();
    }
  });
});
