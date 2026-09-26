import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isApng, sniff } from '@/core/probe/sniff.ts';
import type { ContainerId } from '@/core/types.ts';

const FIXTURES = join(process.cwd(), 'tests/fixtures/generated');
const haveFixtures = existsSync(FIXTURES);

function read(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/**
 * Expected result per fixture, derived from the generator in scripts/gen-fixtures.sh.
 *
 * Asserted against real encoder output rather than hand-written byte vectors, so these
 * are the magic numbers actual tools emit — which is what the sniffer will meet in the wild.
 *
 * Confidence is stated per file rather than assumed to be `definite`: an MP3 or ADTS
 * file is genuinely ambiguous at the first kilobyte (an ID3 tag can prefix either, and
 * a bare frame sync is shared between MPEG audio layers and ADTS), so `probable` is the
 * honest answer there and the caller is expected to confirm with a real parse.
 */
const EXPECTED: Record<string, { container: ContainerId; confidence: 'definite' | 'probable' }> = {
  // still images
  'still.jpg': { container: 'jpeg', confidence: 'definite' },
  'still.png': { container: 'png', confidence: 'definite' },
  'still.webp': { container: 'webp', confidence: 'definite' },
  'still.heic': { container: 'isobmff-heic', confidence: 'definite' },
  // animation
  'anim.gif': { container: 'gif', confidence: 'definite' },
  'anim.apng': { container: 'png', confidence: 'definite' }, // PNG container; isApng() distinguishes
  'anim.webp': { container: 'webp', confidence: 'definite' },
  // video
  'av.mp4': { container: 'isobmff-mp4', confidence: 'definite' },
  'av.mov': { container: 'isobmff-mov', confidence: 'definite' },
  'av.mkv': { container: 'matroska', confidence: 'definite' },
  'av.webm': { container: 'webm', confidence: 'definite' },
  // audio
  'tone.mp3': { container: 'mp3', confidence: 'probable' },
  'tone.m4a': { container: 'isobmff-m4a', confidence: 'definite' },
  'tone.aac': { container: 'adts', confidence: 'probable' },
  'tone.flac': { container: 'flac', confidence: 'definite' },
  'tone.wav': { container: 'wav', confidence: 'definite' },
  'tone-opus.ogg': { container: 'ogg', confidence: 'definite' },
  'tone-vorbis.ogg': { container: 'ogg', confidence: 'definite' },
  // live photo material
  'livepair.mov': { container: 'isobmff-mov', confidence: 'definite' },
};

describe.skipIf(!haveFixtures)('sniff — against real encoder output', () => {
  it('found the fixture corpus', () => {
    expect(readdirSync(FIXTURES).length).toBeGreaterThan(10);
  });

  it.each(Object.entries(EXPECTED))(
    'identifies $0 as $1',
    (file, { container, confidence }) => {
      const result = sniff(read(file));
      expect(result.container).toBe(container);
      expect(result.confidence).toBe(confidence);
    },
  );

  it('distinguishes the ISO-BMFF family by brand, not by extension', () => {
    // MP4, MOV, M4A and HEIC share a container format. Only the ftyp brand separates
    // them — which is exactly why extension-based detection fails here.
    expect(sniff(read('av.mp4')).brand).toBe('isom');
    expect(sniff(read('av.mov')).brand).toBe('qt  ');
    expect(sniff(read('tone.m4a')).brand).toBe('M4A ');
    expect(sniff(read('still.heic')).brand).toBe('heic');
  });

  it('separates Matroska from WebM by DocType, not by magic number', () => {
    // Both start with the same four EBML bytes.
    expect(sniff(read('av.mkv')).docType).toBe('matroska');
    expect(sniff(read('av.webm')).docType).toBe('webm');
  });

  it('reports the animated WebP variant through its codec, not its container', () => {
    // Animated and still WebP share a container; the caller learns which from the
    // codec probe, so the sniffer correctly says only "webp" for both.
    expect(sniff(read('still.webp')).container).toBe('webp');
    expect(sniff(read('anim.webp')).container).toBe('webp');
  });

  it('flags APNG only when the acTL chunk is present', () => {
    expect(isApng(read('anim.apng'))).toBe(true);
    expect(isApng(read('still.png'))).toBe(false);
  });
});

describe('sniff — robustness', () => {
  it('never throws on truncated or junk input', () => {
    const samples: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array(1),
      new Uint8Array(11),
      new Uint8Array([0xff, 0xd8, 0xff]), // JPEG SOI, then nothing
      new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), // EBML magic, no DocType
      new TextEncoder().encode('this is not media at all, not even close'),
      new Uint8Array(2048).fill(0xab),
    ];
    for (const s of samples) {
      expect(() => sniff(s)).not.toThrow();
    }
  });

  it('returns unknown for content it cannot identify', () => {
    expect(sniff(new TextEncoder().encode('hello world, definitely not media')).container).toBe(
      'unknown',
    );
  });

  it('does not treat a truncated ISO-BMFF header as media', () => {
    // `ftyp` present but the brand is cut off — must not report a container.
    const truncated = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70]);
    expect(sniff(truncated).container).toBe('unknown');
  });

  it('survives a PNG with a corrupt chunk length instead of looping', () => {
    // A huge declared length would run the chunk walk off the end; the guard must stop it.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
      0xff, 0xff, 0xff, 0xff, 0x61, 0x62, 0x63, 0x64, // absurd length + type
      0x00, 0x00, 0x00, 0x00,
    ]);
    expect(() => isApng(png)).not.toThrow();
  });
});
