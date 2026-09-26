import { describe, expect, it } from 'vitest';
import { computeFidelity, computeLosses, requiresAcknowledgement } from '@/core/loss/fidelity.ts';
import { ALL_FORMAT_IDS, FORMATS, SCOPE_ALLOWLIST } from '@/core/registry/formats.ts';
import { kindOf } from '@/core/routing/kind.ts';
import { verdictFor } from '@/core/routing/transitions.ts';
import type { FormatId, MediaClass, RouteShape } from '@/core/types.ts';

const ALL_MEDIA_CLASSES: MediaClass[] = [
  'video',
  'animated-image',
  'still-image',
  'audio',
  'live-photo',
  'unknown',
];

describe('kindOf — conversion kind is derived, never declared', () => {
  const cases: Array<[RouteShape, string]> = [
    [{ payload: 'preserved', mediaClass: 'same' }, 'transmux'],
    [{ payload: 'reencoded', mediaClass: 'same' }, 'transcode'],
    [{ payload: 'preserved', mediaClass: 'changed' }, 'projection'],
    [{ payload: 'reencoded', mediaClass: 'changed' }, 'projection'],
  ];

  it.each(cases)('%o derives to %s', (shape, expected) => {
    expect(kindOf(shape)).toBe(expected);
  });

  it('a class change always wins over payload preservation', () => {
    // A Live Photo split that copies bytes is still a projection, not a transmux:
    // the user loses half the artifact regardless of whether re-encoding happened.
    expect(kindOf({ payload: 'preserved', mediaClass: 'changed' })).toBe('projection');
  });
});

describe('computeFidelity — the max() of source and target lossiness', () => {
  const same = { payload: 'reencoded', mediaClass: 'same' } as const;

  it('treats a preserved payload as lossless', () => {
    expect(
      computeFidelity({ shape: { payload: 'preserved', mediaClass: 'same' } }),
    ).toBe('lossless');
  });

  it('treats any class change as a projection', () => {
    expect(
      computeFidelity({ shape: { payload: 'preserved', mediaClass: 'changed' } }),
    ).toBe('projection');
  });

  it('WAV → FLAC is lossless (lossless source, lossless target)', () => {
    expect(
      computeFidelity({ shape: same, sourceCodec: 'pcm', targetCodec: 'flac' }),
    ).toBe('lossless');
  });

  it('FLAC → WAV is lossless', () => {
    expect(
      computeFidelity({ shape: same, sourceCodec: 'flac', targetCodec: 'pcm' }),
    ).toBe('lossless');
  });

  it('MP3 → FLAC is NOT lossless, despite the target being lossless', () => {
    // The whole point of the honesty model: a lossless container cannot restore
    // what a lossy source already discarded.
    expect(
      computeFidelity({ shape: same, sourceCodec: 'mp3', targetCodec: 'flac' }),
    ).toBe('lossy');
  });

  it('MP3 → AAC is lossy', () => {
    expect(
      computeFidelity({ shape: same, sourceCodec: 'mp3', targetCodec: 'aac' }),
    ).toBe('lossy');
  });
});

describe('computeLosses — computed against a real context, never speculative', () => {
  const reencoded = { payload: 'reencoded', mediaClass: 'same' } as const;

  it('flags the generation loss when a lossy source targets a lossless format', () => {
    const items = computeLosses({ shape: reencoded, sourceCodec: 'mp3', targetCodec: 'flac' });
    const codes = items.map((i) => i.code);
    expect(codes).toContain('generation-loss-from-lossy-source');
  });

  it('does NOT warn about alpha when the source has no alpha', () => {
    // Warning fatigue is the failure mode this guards against.
    const items = computeLosses({
      shape: reencoded,
      sourceCodec: 'avc',
      targetCodec: 'avc',
      sourceHasAlpha: false,
      targetSupportsAlpha: false,
    });
    expect(items.map((i) => i.code)).not.toContain('alpha-flattened');
  });

  it('DOES warn about alpha, at critical severity, when transparency would be lost', () => {
    const items = computeLosses({
      shape: reencoded,
      sourceHasAlpha: true,
      targetSupportsAlpha: false,
    });
    const alpha = items.find((i) => i.code === 'alpha-flattened');
    expect(alpha).toBeDefined();
    expect(alpha?.severity).toBe('critical');
    expect(requiresAcknowledgement(items)).toBe(true);
  });

  it('reports the exact number of dropped tracks', () => {
    const items = computeLosses({
      shape: reencoded,
      sourceAudioTracks: 5,
      targetMaxAudioTracks: 2,
    });
    const dropped = items.find((i) => i.code === 'extra-tracks-dropped');
    expect(dropped?.detail).toBe('3 of 5 audio tracks');
  });

  it('does not flag requantizing when the payload is preserved', () => {
    const items = computeLosses({
      shape: { payload: 'preserved', mediaClass: 'same' },
      sourceCodec: 'avc',
      targetCodec: 'avc',
    });
    expect(items.map((i) => i.code)).not.toContain('requantized');
  });

  it('produces no losses for a lossless→lossless copy of a lossless source', () => {
    const items = computeLosses({
      shape: { payload: 'preserved', mediaClass: 'same' },
      sourceCodec: 'flac',
      targetCodec: 'flac',
    });
    expect(items).toEqual([]);
  });
});

describe('transition table — exhaustive over every class × target pair', () => {
  it('resolves a verdict for all pairs without throwing', () => {
    for (const cls of ALL_MEDIA_CLASSES) {
      for (const target of ALL_FORMAT_IDS) {
        expect(() => verdictFor(cls, target)).not.toThrow();
      }
    }
  });

  it('every impossible pair supplies a reason the UI can render', () => {
    for (const cls of ALL_MEDIA_CLASSES) {
      for (const target of ALL_FORMAT_IDS) {
        const v = verdictFor(cls, target);
        if (v.kind === 'impossible') {
          expect(v.reason).toBeTruthy();
        }
      }
    }
  });

  it('audio can reach audio formats but never video or images', () => {
    // The headline promise of the "impossible conversions" list.
    for (const target of ['mp4', 'mov', 'mkv', 'webm'] as FormatId[]) {
      expect(verdictFor('audio', target)).toEqual({
        kind: 'impossible',
        reason: 'needs-visual-component',
      });
    }
    for (const target of ['jpeg', 'png', 'webp'] as FormatId[]) {
      expect(verdictFor('audio', target)).toEqual({
        kind: 'impossible',
        reason: 'class-mismatch',
      });
    }
    for (const target of ['mp3', 'flac', 'wav', 'm4a', 'ogg', 'aac'] as FormatId[]) {
      expect(verdictFor('audio', target).kind).not.toBe('impossible');
    }
  });

  it('a still image can never become motion or a Live Photo', () => {
    expect(verdictFor('still-image', 'gif')).toEqual({
      kind: 'impossible',
      reason: 'needs-multiple-frames',
    });
    expect(verdictFor('still-image', 'live-photo')).toEqual({
      kind: 'impossible',
      reason: 'livephoto-needs-video',
    });
    expect(verdictFor('still-image', 'mp4')).toEqual({
      kind: 'impossible',
      reason: 'needs-motion-component',
    });
  });

  it('a Live Photo can be split into either half, and repacked as itself', () => {
    expect(verdictFor('live-photo', 'mp4')).toEqual({
      kind: 'project',
      projector: 'split-video',
    });
    expect(verdictFor('live-photo', 'jpeg')).toEqual({
      kind: 'project',
      projector: 'split-still',
    });
    expect(verdictFor('live-photo', 'live-photo')).toEqual({
      kind: 'project',
      projector: 'repack-live',
    });
  });
});

describe('format registry — invariants', () => {
  it('every declared parameter is inside the scope allowlist', () => {
    // This is the enforcement point for "conversion + encoding parameters only".
    // A new knob must be a deliberate edit to SCOPE_ALLOWLIST.
    for (const id of ALL_FORMAT_IDS) {
      for (const param of FORMATS[id].params) {
        expect(SCOPE_ALLOWLIST).toContain(param.id);
      }
    }
  });

  it('no format declares the same parameter twice', () => {
    for (const id of ALL_FORMAT_IDS) {
      const ids = FORMATS[id].params.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('every format has an extension and a mime type', () => {
    for (const id of ALL_FORMAT_IDS) {
      expect(FORMATS[id].extension).toMatch(/^[a-z0-9]+$/);
      expect(FORMATS[id].mime).toMatch(/^[a-z]+\/[\w.+-]+$/);
    }
  });

  it('every format declares at least one accepted source class', () => {
    for (const id of ALL_FORMAT_IDS) {
      expect(FORMATS[id].acceptsClasses.length).toBeGreaterThan(0);
    }
  });
});
