import { describe, expect, it } from 'vitest';
import { IMPOSSIBILITY_COPY } from '@/core/routing/impossibility.ts';
import { planFor } from '@/core/routing/resolve.ts';
import {
  readRouteCapabilities,
  shutGate,
  type GateContext,
  type RouteCapabilities,
} from '@/core/routing/gates.ts';
import { verdictFor } from '@/core/routing/transitions.ts';
import type { MediaProfile } from '@/core/probe/profile.ts';
import type { CodecId, ContainerId, FormatId } from '@/core/types.ts';

/**
 * The capability doors.
 *
 * The subject here is the difference between "we could do this" and "this machine can do
 * this". `verdictFor()` answers the first, and its answers never change; the doors answer
 * the second, and a route that ignores them is a button that fails at the end of a job
 * rather than one that explains itself.
 */

/** Nothing works here. The codec door stays quiet unless a test names a codec. */
const NOTHING: RouteCapabilities = {
  imageDecoder: false,
  crossOriginIsolated: false,
  encodable: new Set(),
};

/** Everything works here. */
const EVERY_CODEC = new Set<CodecId>([
  'avc',
  'hevc',
  'vp8',
  'vp9',
  'av1',
  'aac',
  'opus',
  'mp3',
  'flac',
  'vorbis',
]);
const FULL: RouteCapabilities = {
  imageDecoder: true,
  crossOriginIsolated: true,
  encodable: EVERY_CODEC,
};

/** A track with just enough shape for the doors to judge it. */
function track(codec: string, decodable: boolean) {
  return { codec, width: 1920, height: 1080, decodable };
}

function audioTrack(codec: string, decodable: boolean) {
  return { codec, channels: 2, sampleRate: 44100, decodable };
}

/**
 * A gate context, open in every respect unless the test says otherwise.
 *
 * Defaults describe the boring, entirely workable case: a plain video whose bytes are
 * being copied. Each test then changes exactly the one thing it is about.
 */
function ctx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    profile: {
      mediaClass: 'video',
      container: 'isobmff-mp4',
      videoTracks: [],
      audioTracks: [],
    },
    target: 'mp4',
    params: {},
    caps: FULL,
    verdict: { kind: 'direct' },
    copyable: true,
    ...overrides,
  };
}

/** A context whose source class and container are the two under test. */
function from(mediaClass: MediaProfile['mediaClass'], container: ContainerId, rest: Partial<GateContext> = {}): GateContext {
  return ctx({ profile: { ...ctx().profile, mediaClass, container }, ...rest });
}

describe('readRouteCapabilities', () => {
  it('answers with booleans even where the APIs are absent', () => {
    // It runs in a plain node process here, which has neither — the point is that asking
    // is always safe and never throws.
    const caps = readRouteCapabilities();
    expect(typeof caps.imageDecoder).toBe('boolean');
    expect(typeof caps.crossOriginIsolated).toBe('boolean');
  });
});

describe('fallback engine door — 兜底引擎无法运行', () => {
  it('三种只有它能源的目标，在未开启跨源隔离时全部关闭', () => {
    // ffmpeg.wasm does not fail without isolation — it hangs, which is a much worse way
    // to learn about it.
    for (const target of ['webp-anim', 'apng', 'live-photo'] as FormatId[]) {
      expect(shutGate(ctx({ target, caps: NOTHING }))?.reason, target).toBe('engine-unavailable');
    }
  });

  it('Motion Photo 不在那条清单里——它不需要兜底引擎，也不需要隔离', () => {
    // The whole reason it is the cheaper flavour, and gating it would be a lie.
    expect(shutGate(ctx({ target: 'motion-photo', caps: NOTHING }))).toBeNull();
  });

  it('Ogg 只在用户真的选了 Vorbis 时才需要兜底引擎', () => {
    const a = { target: 'ogg' as FormatId, caps: NOTHING };
    expect(shutGate(ctx({ ...a, params: { codec: 'vorbis' } }))?.reason).toBe('engine-unavailable');
    // The default is Opus, which the primary engine writes with no download at all.
    expect(shutGate(ctx({ ...a, params: { codec: 'opus' } }))).toBeNull();
    expect(shutGate(ctx({ ...a, params: {} }))).toBeNull();
  });

  it('对目标无关的路由一概不管', () => {
    // A door that fires on routes it has no business in is worse than none: it disables
    // things that work, and the reason it gives would be nonsense.
    for (const target of ['mp4', 'gif', 'mp3', 'jpeg'] as FormatId[]) {
      expect(shutGate(ctx({ target, caps: NOTHING })), target).toBeNull();
    }
  });
});

describe('image decoder door — 浏览器的取帧 API 缺席', () => {
  it('没有 ImageDecoder 时，动态 WebP 与 APNG 取不出帧', () => {
    // Not a stylistic preference: the browser's image API is the only thing that can
    // take these two apart. Nothing else reads either format's frames.
    for (const container of ['webp', 'png'] as ContainerId[]) {
      for (const target of ['gif', 'mp4', 'mov', 'mkv', 'webm'] as FormatId[]) {
        expect(shutGate(from('animated-image', container, { target, caps: NOTHING }))?.reason, `${container} → ${target}`).toBe(
          'no-decoder-in-browser',
        );
      }
    }
  });

  it('取单帧不需要 ImageDecoder，所以静图目标不受影响', () => {
    // `createImageBitmap` hands over the first frame without touching WebCodecs, and the
    // still-image targets ask for nothing more. Gating too widely would disable routes
    // that work perfectly well.
    for (const target of ['jpeg', 'png', 'webp'] as FormatId[]) {
      expect(shutGate(from('animated-image', 'webp', { target, caps: NOTHING })), target).toBeNull();
    }
  });

  it('GIF 不走这条路——它的帧来自 GIF 库，而不是浏览器的图像 API', () => {
    for (const target of ['gif', 'mp4', 'webm', 'motion-photo'] as FormatId[]) {
      expect(shutGate(from('animated-image', 'gif', { target, caps: NOTHING })), target).toBeNull();
    }

    // The one animated format that survives on a machine with no image API at all. Its
    // Live Photo still needs the fallback engine for the pairing identifier — but that is
    // a different door, and with isolation on this is the route that remains.
    const isolated: RouteCapabilities = { imageDecoder: false, crossOriginIsolated: true, encodable: EVERY_CODEC };
    expect(shutGate(from('animated-image', 'gif', { target: 'live-photo', caps: isolated }))).toBeNull();
    expect(
      shutGate(from('animated-image', 'gif', { target: 'live-photo', caps: NOTHING }))?.reason,
    ).toBe('engine-unavailable');
  });

  it('两扇门同时关着时，报告更根本的那一扇', () => {
    // A Live Photo whose motion half would come from an animated WebP needs both. With
    // neither available the honest answer is the one that stops the job first.
    const both = { target: 'live-photo' as FormatId };
    expect(shutGate(from('animated-image', 'webp', { ...both, caps: NOTHING }))?.reason).toBe(
      'engine-unavailable',
    );

    // And once the engine is there, the remaining obstacle is the one that is left.
    expect(
      shutGate(from('animated-image', 'webp', { ...both, caps: { ...NOTHING, crossOriginIsolated: true } }))
        ?.reason,
    ).toBe('no-decoder-in-browser');
    expect(shutGate(from('animated-image', 'webp', { ...both, caps: FULL }))).toBeNull();
  });

  it('每一扇关着的门都带着能读的理由', () => {
    const shutGates = [
      shutGate(from('animated-image', 'webp', { target: 'gif', caps: NOTHING })),
      shutGate(from('animated-image', 'webp', { target: 'live-photo', caps: NOTHING })),
    ];

    for (const gate of shutGates) {
      expect(gate).not.toBeNull();
      const rendered = IMPOSSIBILITY_COPY[gate!.reason].body({
        reason: gate!.reason,
        detail: gate!.detail,
        alternatives: [],
      });
      // The copy slots the detail into a sentence; a missing one would leave a gap the
      // user reads as a bug.
      expect(rendered).toContain(gate!.detail);
      expect(rendered).not.toMatch(/undefined|null/);
      expect(IMPOSSIBILITY_COPY[gate!.reason].title.length).toBeGreaterThan(0);
    }
  });
});

describe('decoder door — 源解不开', () => {
  it('换容器不解码任何东西，所以解不开的轨道拦不住它', () => {
    // This is the door's most important exclusion. Blocking a container change because
    // the packets inside could not be decoded would disable the one operation that
    // genuinely cannot fail — and it is the operation the app steers users toward.
    const stuck = ctx({ profile: { ...ctx().profile, videoTracks: [track('hevc', false)] } });
    expect(shutGate(stuck)).toBeNull();
  });

  it('要重新编码时，解不开的轨道就是一道关着的门', () => {
    const stuck = ctx({
      profile: { ...ctx().profile, videoTracks: [track('hevc', false)] },
      target: 'gif',
      copyable: false,
    });
    expect(shutGate(stuck)?.reason).toBe('no-decoder-in-browser');
    // Named, so the user can tell whether switching browsers would help.
    expect(shutGate(stuck)?.detail).toBe('H.265');
  });

  it('导出一个包的静图那一半，从不触碰它的视频', () => {
    // An HEVC Live Photo must still export its JPEG on a browser that cannot decode
    // HEVC. Refusing it would be a route disabled for no reason — which is its own kind
    // of lie, and the mirror of the bug these doors exist to prevent.
    const livePhoto = ctx({
      profile: {
        mediaClass: 'live-photo',
        container: 'zip',
        videoTracks: [track('hevc', false)],
        audioTracks: [],
      },
      target: 'jpeg',
      verdict: { kind: 'project', projector: 'split-still' },
      copyable: false,
    });
    expect(shutGate(livePhoto)).toBeNull();
  });

  it('目标不带声音时，解不开的音轨不算数', () => {
    // A GIF drops the soundtrack, so a video with an unreadable one can still become a
    // GIF. Gating on every track would refuse that for no reason.
    const profile = {
      mediaClass: 'video' as const,
      container: 'isobmff-mp4' as const,
      videoTracks: [track('avc', true)],
      audioTracks: [audioTrack('vorbis', false)],
    };

    expect(shutGate(ctx({ profile, target: 'gif', copyable: false }))).toBeNull();
    // But a target that does carry sound needs it decoded.
    expect(shutGate(ctx({ profile, target: 'mp4', copyable: false }))?.detail).toBe('Vorbis');
  });

  it('全都解得开时，门是开的', () => {
    const profile = {
      mediaClass: 'video' as const,
      container: 'isobmff-mp4' as const,
      videoTracks: [track('avc', true)],
      audioTracks: [audioTrack('aac', true)],
    };
    expect(shutGate(ctx({ profile, target: 'webm', copyable: false }))).toBeNull();
  });
});

describe('encoder door — 点名要的编码，这里产不出来', () => {
  /** A machine that can encode nothing at all — the harshest case the door may face. */
  const NO_ENCODERS: RouteCapabilities = { ...FULL, encodable: new Set<CodecId>() };

  it('用户没点名时，一律不管', () => {
    // Choosing nothing hands the decision to the engine, which walks the target's codec
    // list and takes the first one it can encode. There is no decision to second-guess,
    // so there is nothing to refuse.
    expect(shutGate(ctx({ params: {}, caps: NO_ENCODERS }))).toBeNull();
    expect(shutGate(ctx({ params: { quality: 80 }, caps: NO_ENCODERS }))).toBeNull();
  });

  it('面板播种的默认值不算一次点名', () => {
    // The panel seeds every control, so a codec sitting at its declared default is
    // present in `params` without being a decision. Judging it would refuse a conversion
    // the engine would have completed by picking something it can encode.
    expect(shutGate(ctx({ target: 'mp4', params: { codec: 'avc' }, caps: NO_ENCODERS }))).toBeNull();
    expect(shutGate(ctx({ target: 'mkv', params: { codec: 'avc' }, caps: NO_ENCODERS }))).toBeNull();
  });

  it('点名一个本机编不出来的编码，门就关了', () => {
    // The H.265 option says so itself — 「更小，但只有 Apple 端能编码」 — and a control
    // that admits it might not work is a control that should have been disabled.
    const plan = ctx({ target: 'mp4', params: { codec: 'hevc' }, caps: NO_ENCODERS });
    expect(shutGate(plan)?.reason).toBe('no-encoder-in-browser');
    expect(shutGate(plan)?.detail).toBe('H.265');
  });

  it('点名一个本机编得出来的，门开着', () => {
    const caps: RouteCapabilities = { ...FULL, encodable: new Set<CodecId>(['avc', 'hevc']) };
    expect(shutGate(ctx({ target: 'mp4', params: { codec: 'hevc' }, caps }))).toBeNull();
  });

  it('还没测过时不判——没测过不等于没有', () => {
    // `null` is a state of its own. An unmeasured machine is not a machine without
    // encoders, and the window only spans the page mounting to the probe landing.
    const unmeasured: RouteCapabilities = { ...FULL, encodable: null };
    expect(shutGate(ctx({ target: 'mp4', params: { codec: 'hevc' }, caps: unmeasured }))).toBeNull();
  });

  it('Vorbis 归兜底引擎那道门管，这里不重复判决', () => {
    // Vorbis has no browser encoder and was never going to be asked of one: the fallback
    // engine writes it, and its door has already ruled. Judging it here would report the
    // wrong reason for a route that is open precisely when isolation is on.
    const isolated: RouteCapabilities = { ...NO_ENCODERS, crossOriginIsolated: true };
    expect(shutGate(ctx({ target: 'ogg', params: { codec: 'vorbis' }, caps: isolated }))).toBeNull();

    // And when isolation is missing, it is the *other* door that says so — which is why
    // this one must not also speak.
    const withoutIsolation: RouteCapabilities = { ...NOTHING, encodable: new Set() };
    expect(shutGate(ctx({ target: 'ogg', params: { codec: 'vorbis' }, caps: withoutIsolation }))?.reason)
      .toBe('engine-unavailable');
  });

  it('理由读得通', () => {
    const gate = shutGate(ctx({ target: 'mp4', params: { codec: 'hevc' }, caps: NO_ENCODERS }))!;
    const rendered = IMPOSSIBILITY_COPY[gate.reason].body({
      reason: gate.reason,
      detail: gate.detail,
      alternatives: [],
    });
    expect(rendered).toContain('H.265');
    expect(rendered).not.toMatch(/undefined|null/);
  });
});

describe('planFor — 门落在计划上，而不是路由表上', () => {
  /** An animated WebP, the source class most of these doors are about. */
  const animatedWebp: MediaProfile = {
    name: 'x.webp',
    size: 1,
    container: 'webp',
    mediaClass: 'animated-image',
    videoTracks: [],
    audioTracks: [],
    otherTrackCount: 0,
    isAnimated: true,
  };

  /** Build a minimal profile for a container with the given codecs. */
  function profileWith(
    mediaClass: MediaProfile['mediaClass'],
    opts: { video?: string[]; audio?: string[] } = {},
  ): MediaProfile {
    return {
      name: 'x',
      size: 1,
      container: 'isobmff-mp4',
      mediaClass,
      videoTracks: (opts.video ?? []).map((codec) => ({
        codec,
        width: 1920,
        height: 1080,
        decodable: true,
      })),
      audioTracks: (opts.audio ?? []).map((codec) => ({
        codec,
        channels: 2,
        sampleRate: 44100,
        decodable: true,
      })),
      otherTrackCount: 0,
    };
  }

  /** A video whose picture codec this browser cannot decode. */
  const unplayable: MediaProfile = {
    name: 'x.mp4',
    size: 1,
    container: 'isobmff-mp4',
    mediaClass: 'video',
    videoTracks: [{ codec: 'hevc', width: 1920, height: 1080, decodable: false }],
    audioTracks: [{ codec: 'aac', channels: 2, sampleRate: 44100, decodable: true }],
    otherTrackCount: 0,
  };

  it('路由表本身不受影响：同一对格式在任何机器上判定一致', () => {
    // This is what keeps the exhaustive matrix test meaningful. Doors belong to the
    // machine, verdicts belong to the format pair.
    expect(verdictFor('animated-image', 'mp4')).toEqual({ kind: 'direct' });
    expect(verdictFor('animated-image', 'live-photo')).toEqual({
      kind: 'project',
      projector: 'repack-live',
    });
  });

  it('机器做不到时，计划不可行并说明是哪一扇门', () => {
    const plan = planFor(animatedWebp, 'mp4', NOTHING);
    expect(plan.feasible).toBe(false);
    expect(plan.impossibility?.reason).toBe('no-decoder-in-browser');
    expect(plan.impossibility?.detail).toContain('WebP');
    // Still a real list of alternatives — a dead end is not a reason.
    expect(plan.impossibility?.alternatives).toContain('gif' as FormatId);
  });

  it('同一份输入在能跑的机器上照常可行', () => {
    const plan = planFor(animatedWebp, 'mp4', FULL);
    expect(plan.feasible).toBe(true);
    expect(plan.verdict.kind).toBe('direct');
  });

  it('解不开的视频仍然可以换容器——那不需要解码', () => {
    // The whole point of the exclusion. This file can be put into another container on
    // any machine; it can only be re-encoded where HEVC decodes.
    const transmux = planFor(unplayable, 'mkv', FULL);
    expect(transmux.feasible).toBe(true);
    expect(transmux.did).toBe('transmux');

    const reencode = planFor(unplayable, 'webm', FULL);
    expect(reencode.feasible).toBe(false);
    expect(reencode.impossibility?.reason).toBe('no-decoder-in-browser');
    expect(reencode.impossibility?.detail).toBe('H.265');
  });

  it('点名一个本机编不出来的编码，计划随之不可行', () => {
    // The end-to-end shape of the door: the same file and the same target, decided by the
    // codec the user named and by what this machine can do about it.
    const source = profileWith('video', { video: ['avc'], audio: ['aac'] });
    const noHevc: RouteCapabilities = { ...FULL, encodable: new Set<CodecId>(['avc', 'vp9']) };

    const blocked = planFor(source, 'mp4', noHevc, { codec: 'hevc' });
    expect(blocked.feasible).toBe(false);
    expect(blocked.impossibility?.reason).toBe('no-encoder-in-browser');
    expect(blocked.impossibility?.detail).toBe('H.265');
    // Alternatives are still offered — a refusal that is a dead end is not a reason.
    expect(blocked.impossibility?.alternatives).toContain('mkv' as FormatId);

    const fine = planFor(source, 'mp4', FULL, { codec: 'hevc' });
    expect(fine.feasible).toBe(true);
  });

  it('可行性随门变化，而不是随格式对变化', () => {
    // The same conversion, two machines' worth of answers.
    const withDecoder = planFor(animatedWebp, 'mov', { ...NOTHING, imageDecoder: true });
    const withoutDecoder = planFor(animatedWebp, 'mov', NOTHING);
    expect(withDecoder.feasible).toBe(true);
    expect(withoutDecoder.feasible).toBe(false);
  });
});
