import { describe, expect, it } from 'vitest';
import { IMPOSSIBILITY_COPY } from '@/core/routing/impossibility.ts';
import { planFor } from '@/core/routing/resolve.ts';
import {
  readRouteCapabilities,
  shutGate,
  type RouteCapabilities,
} from '@/core/routing/gates.ts';
import { verdictFor } from '@/core/routing/transitions.ts';
import type { MediaProfile } from '@/core/probe/profile.ts';
import type { ContainerId, FormatId } from '@/core/types.ts';

/**
 * The capability gates.
 *
 * The subject here is the difference between "we could do this" and "this machine can do
 * this". `verdictFor()` answers the first, and its answers never change; these gates
 * answer the second, and a route that ignores them is a button that fails at the end of a
 * job rather than one that explains itself.
 */

const NOTHING: RouteCapabilities = { imageDecoder: false, crossOriginIsolated: false };
const FULL: RouteCapabilities = { imageDecoder: true, crossOriginIsolated: true };

/** A source of the given class in the given container. */
function source(mediaClass: MediaProfile['mediaClass'], container: ContainerId) {
  return { mediaClass, container };
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

describe('shutGate — 被机器挡住的路由', () => {
  it('没有 ImageDecoder 时，动态 WebP 与 APNG 取不出帧', () => {
    // Not a stylistic preference: the browser's image API is the only thing that can
    // take these two apart. Nothing else reads either format's frames.
    for (const container of ['webp', 'png'] as ContainerId[]) {
      const src = source('animated-image', container);
      for (const target of ['gif', 'mp4', 'mov', 'mkv', 'webm'] as FormatId[]) {
        expect(shutGate(src, target, {}, NOTHING)?.reason, `${container} → ${target}`).toBe(
          'no-decoder-in-browser',
        );
      }
    }
  });

  it('取单帧不需要 ImageDecoder，所以静图目标不受影响', () => {
    // `createImageBitmap` hands over the first frame without touching WebCodecs, and the
    // still-image targets ask for nothing more. Gating too widely would disable routes
    // that work perfectly well.
    const src = source('animated-image', 'webp');
    for (const target of ['jpeg', 'png', 'webp'] as FormatId[]) {
      expect(shutGate(src, target, {}, NOTHING), target).toBeNull();
    }
  });

  it('GIF 不走这条路——它的帧来自 GIF 库，而不是浏览器的图像 API', () => {
    const src = source('animated-image', 'gif');
    for (const target of ['gif', 'mp4', 'webm', 'motion-photo'] as FormatId[]) {
      expect(shutGate(src, target, {}, NOTHING), target).toBeNull();
    }

    // The one animated format that survives on a machine with no image API at all. Its
    // Live Photo still needs the fallback engine for the pairing identifier — but that is
    // a different gate, and with isolation on this is the route that remains.
    const isolated: RouteCapabilities = { imageDecoder: false, crossOriginIsolated: true };
    expect(shutGate(src, 'live-photo', {}, isolated)).toBeNull();
    expect(shutGate(src, 'live-photo', {}, NOTHING)?.reason).toBe('engine-unavailable');
  });

  it('兜底引擎的三种目标在未开启跨源隔离时全部关闭', () => {
    // ffmpeg.wasm does not fail without isolation — it hangs, which is a much worse way
    // to learn about it.
    for (const target of ['webp-anim', 'apng', 'live-photo'] as FormatId[]) {
      expect(shutGate(source('video', 'isobmff-mp4'), target, {}, NOTHING)?.reason, target).toBe(
        'engine-unavailable',
      );
    }
  });

  it('Motion Photo 不在那条清单里——它不需要兜底引擎，也不需要隔离', () => {
    // The whole reason it is the cheaper flavour, and gating it would be a lie.
    expect(shutGate(source('video', 'isobmff-mp4'), 'motion-photo', {}, NOTHING)).toBeNull();
  });

  it('Ogg 只在用户真的选了 Vorbis 时才需要兜底引擎', () => {
    const src = source('audio', 'wav');
    expect(shutGate(src, 'ogg', { codec: 'vorbis' }, NOTHING)?.reason).toBe('engine-unavailable');
    // The default is Opus, which the primary engine writes with no download at all.
    expect(shutGate(src, 'ogg', { codec: 'opus' }, NOTHING)).toBeNull();
    expect(shutGate(src, 'ogg', {}, NOTHING)).toBeNull();
  });

  it('对目标无关的路由一概不管', () => {
    // A gate that fires on routes it has no business in is worse than none: it disables
    // things that work, and the reason it gives would be nonsense.
    for (const target of ['mp4', 'gif', 'mp3', 'jpeg'] as FormatId[]) {
      expect(shutGate(source('video', 'isobmff-mp4'), target, {}, NOTHING), target).toBeNull();
    }
  });

  it('两扇门同时关着时，报告更根本的那一扇', () => {
    // A Live Photo whose motion half would come from an animated WebP needs both. With
    // neither available the honest answer is the one that stops the job first.
    const src = source('animated-image', 'webp');
    expect(shutGate(src, 'live-photo', {}, NOTHING)?.reason).toBe('engine-unavailable');

    // And once the engine is there, the remaining obstacle is the one that is left.
    expect(shutGate(src, 'live-photo', {}, { imageDecoder: false, crossOriginIsolated: true })
      ?.reason).toBe('no-decoder-in-browser');
    expect(shutGate(src, 'live-photo', {}, FULL)).toBeNull();
  });

  it('每一扇关着的门都带着能读的理由', () => {
    const reasons = ['no-decoder-in-browser', 'engine-unavailable'] as const;
    for (const reason of reasons) {
      const gate = shutGate(source('animated-image', 'webp'), 'gif', {}, NOTHING)!;
      expect(gate).not.toBeNull();
      const rendered = IMPOSSIBILITY_COPY[gate.reason].body({
        reason: gate.reason,
        detail: gate.detail,
        alternatives: [],
      });
      // The copy slots the detail into a sentence; a missing one would leave a gap the
      // user reads as a bug.
      expect(rendered).toContain(gate.detail);
      expect(rendered).not.toMatch(/undefined|null/);
      expect(IMPOSSIBILITY_COPY[reason].title.length).toBeGreaterThan(0);
    }
  });
});

describe('planFor — 闸门落在计划上，而不是路由表上', () => {
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

  it('路由表本身不受影响：同一对格式在任何机器上判定一致', () => {
    // This is what keeps the exhaustive matrix test meaningful. Gates belong to the
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

  it('可行性随闸门变化，而不是随格式对变化', () => {
    // The same conversion, three machines' worth of answers.
    const withDecoder = planFor(animatedWebp, 'mov', { imageDecoder: true, crossOriginIsolated: false });
    const withoutDecoder = planFor(animatedWebp, 'mov', NOTHING);
    expect(withDecoder.feasible).toBe(true);
    expect(withoutDecoder.feasible).toBe(false);
  });
});
