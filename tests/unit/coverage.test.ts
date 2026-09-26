import { describe, expect, it } from 'vitest';

import { ALL_FORMAT_IDS, FORMATS } from '@/core/registry/formats.ts';
import { verdictFor } from '@/core/routing/transitions.ts';
import { MEDIA_CLASS_LABELS } from '@/core/probe/classify.ts';
import type { MediaClass } from '@/core/types.ts';
import { ImageEngine } from '@/engines/image/index.ts';
import { MediabunnyEngine } from '@/engines/mediabunny/index.ts';
import { AnimationEngine } from '@/engines/animation/index.ts';
import { LivePhotoEngine } from '@/engines/livephoto/index.ts';
import { FfmpegEngine } from '@/engines/ffmpeg/index.ts';

/**
 * The contract between routing and the engines.
 *
 * Routing and implementation are written in different vocabularies — one speaks of media
 * classes and verdicts, the other of formats and writers — and nothing in the type system
 * connects them. A target the router calls feasible but no engine can write is the worst
 * kind of gap: the UI offers it, the user picks it, and the job fails at the end with
 * "no engine can output this". The button was the lie, not the error.
 *
 * So the invariant is asserted here, over every target, rather than trusted.
 */

const ENGINES = [
  new LivePhotoEngine(),
  new ImageEngine(),
  new MediabunnyEngine(),
  new AnimationEngine(),
  new FfmpegEngine(),
];

const CLASSES: MediaClass[] = ['video', 'animated-image', 'still-image', 'audio', 'live-photo'];

/** Is any routed-to class able to reach this target? */
function isOffered(target: (typeof ALL_FORMAT_IDS)[number]): boolean {
  return CLASSES.some((c) => verdictFor(c, target).kind !== 'impossible');
}

describe('engine coverage — every offered target can actually be produced', () => {
  it('has at least one engine for every target the router offers', () => {
    const orphans = ALL_FORMAT_IDS.filter(
      (target) => isOffered(target) && !ENGINES.some((e) => e.supports(target)),
    );

    expect(
      orphans.map((t) => `${FORMATS[t].label} (${t})`),
      '这些目标会被界面提供，但没有任何引擎能输出它们',
    ).toEqual([]);
  });

  it('does not claim targets the router never offers', () => {
    // The mirror image, and the reason it matters is different: an engine supporting a
    // format no class can reach is dead code that will drift out of date unnoticed.
    const unreachable = ALL_FORMAT_IDS.filter(
      (target) => !isOffered(target) && ENGINES.some((e) => e.supports(target)),
    );
    expect(unreachable).toEqual([]);
  });

  it('every media class has a label and at least one reachable target', () => {
    // A class with no reachable target renders as a file card with an empty picker and
    // no explanation, which reads as a bug to the user.
    for (const cls of Object.keys(MEDIA_CLASS_LABELS) as MediaClass[]) {
      if (cls === 'unknown') continue;
      const reachable = ALL_FORMAT_IDS.filter((t) => verdictFor(cls, t).kind !== 'impossible');
      expect(reachable.length, `${MEDIA_CLASS_LABELS[cls]} 没有任何可达目标`).toBeGreaterThan(0);
    }
  });
});
