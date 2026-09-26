import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { imageHasAlpha } from '@/core/probe/sniff.ts';
import type { ContainerId } from '@/core/types.ts';

/**
 * Transparency detection.
 *
 * This is what turns "your transparent logo became a white square" from a surprise into
 * a warning the user sees before pressing Convert, so it is worth testing carefully.
 */

const FIXTURES = join(process.cwd(), 'tests/fixtures/generated');
const haveFixtures = existsSync(FIXTURES);

const asciiBytes = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe('imageHasAlpha — against real encoder output', () => {
  it.skipIf(!haveFixtures)('detects an RGBA PNG', () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'alpha.png')));
    expect(imageHasAlpha(bytes, 'png')).toBe(true);
  });

  it.skipIf(!haveFixtures)('does not claim a plain RGB PNG has alpha', () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'still.png')));
    expect(imageHasAlpha(bytes, 'png')).toBe(false);
  });

  it.skipIf(!haveFixtures)('never reports alpha for a JPEG', () => {
    // JPEG has no alpha channel at all, so the answer is final rather than unknown.
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'still.jpg')));
    expect(imageHasAlpha(bytes, 'jpeg')).toBe(false);
  });
});

describe('imageHasAlpha — PNG colour types', () => {
  /** Build a PNG header with the given IHDR colour type. */
  function pngWithColourType(colourType: number): Uint8Array {
    return new Uint8Array([
      ...asciiBytes('\x89PNG\r\n\x1a\n'),
      0, 0, 0, 13,
      ...asciiBytes('IHDR'),
      0, 0, 0, 1, 0, 0, 0, 1,
      8, colourType, 0, 0, 0,
      0, 0, 0, 0,
    ]);
  }

  it('colour type 6 (truecolour + alpha) has alpha', () => {
    expect(imageHasAlpha(pngWithColourType(6), 'png')).toBe(true);
  });

  it('colour type 4 (greyscale + alpha) has alpha', () => {
    expect(imageHasAlpha(pngWithColourType(4), 'png')).toBe(true);
  });

  it('colour type 2 (plain truecolour) has no alpha', () => {
    expect(imageHasAlpha(pngWithColourType(2), 'png')).toBe(false);
  });

  it('colour type 0 (greyscale) has no alpha', () => {
    expect(imageHasAlpha(pngWithColourType(0), 'png')).toBe(false);
  });
});

describe('imageHasAlpha — GIF transparency', () => {
  /**
   * A hand-built GIF89a.
   *
   * Synthetic on purpose: GIF transparency arrived with the 89a revision, and no encoder
   * available on this machine emits one — Pillow writes 87a (which predates the feature)
   * and ffmpeg's palettegen hangs on a fully transparent source. What is under test here
   * is our block walker, and a hand-built stream exercises it precisely.
   */
  function gif89a(transparent: boolean): Uint8Array {
    return new Uint8Array([
      ...asciiBytes('GIF89a'),
      // Logical screen descriptor: 1×1, global colour table of 2 entries
      0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
      // Global colour table
      0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
      // Graphic control extension: [0x21][0xF9][size=4][packed][delay:2][index][0]
      // bit 0 of `packed` is the transparency flag.
      0x21, 0xf9, 0x04, transparent ? 0x01 : 0x00, 0x00, 0x00, 0x00, 0x00,
      // Trailer
      0x3b,
    ]);
  }

  it('detects the transparent-colour flag', () => {
    expect(imageHasAlpha(gif89a(true), 'gif')).toBe(true);
  });

  it('does not fire when the flag is clear', () => {
    expect(imageHasAlpha(gif89a(false), 'gif')).toBe(false);
  });

  it('says no for an animated GIF whose flag is only frame-delta bookkeeping', () => {
    // The finding behind this rule: ffmpeg's fully opaque `testsrc` GIF sets the
    // transparent-colour flag on 9 of its 10 control extensions, using it to mean
    // "unchanged from the previous frame". Reporting alpha there would be a false
    // alarm, so animated GIFs are excluded and still ones are not.
    if (!haveFixtures) return;
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'anim.gif')));
    expect(imageHasAlpha(bytes, 'gif')).toBe(false);
  });
});

describe('imageHasAlpha — WebP', () => {
  /** Build a WebP with an extended-format (VP8X) header carrying the given flags. */
  function webpWithFlags(flags: number): Uint8Array {
    return new Uint8Array([
      ...asciiBytes('RIFF'),
      22, 0, 0, 0,
      ...asciiBytes('WEBP'),
      ...asciiBytes('VP8X'),
      10, 0, 0, 0,
      flags,
      0, 0, 0,
      0, 0, 0,
    ]);
  }

  it('reads the alpha bit from the VP8X flags', () => {
    expect(imageHasAlpha(webpWithFlags(0x10), 'webp')).toBe(true);
  });

  it('does not fire when the alpha bit is clear', () => {
    expect(imageHasAlpha(webpWithFlags(0x00), 'webp')).toBe(false);
  });

  it('says no for a simple-format VP8 WebP, which cannot carry alpha', () => {
    if (!haveFixtures) return;
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'still.webp')));
    expect(imageHasAlpha(bytes, 'webp')).toBe(false);
  });
});

describe('imageHasAlpha — robustness', () => {
  it('never throws on junk, and never claims alpha it cannot see', () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5]);
    for (const c of ['png', 'gif', 'jpeg', 'webp'] as ContainerId[]) {
      expect(() => imageHasAlpha(junk, c)).not.toThrow();
      expect(imageHasAlpha(junk, c)).toBe(false);
    }
  });

  it('returns false for an empty buffer', () => {
    expect(imageHasAlpha(new Uint8Array(0), 'png')).toBe(false);
  });
});
