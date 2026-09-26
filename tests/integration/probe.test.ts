import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probe } from '@/core/probe/probe.ts';
import { describeProfile } from '@/core/probe/profile.ts';
import type { MediaClass } from '@/core/types.ts';

/**
 * Probe tests against the real fixture corpus.
 *
 * The probe is the front door: every routing and loss decision downstream reads its
 * output, so a wrong class here silently sends the user down a path that cannot work.
 */

const FIXTURES = join(process.cwd(), 'tests/fixtures/generated');
const haveFixtures = existsSync(FIXTURES);

const blobFor = (name: string) => new Blob([new Uint8Array(readFileSync(join(FIXTURES, name)))]);
const profileOf = (name: string) => probe(blobFor(name), name);

describe.skipIf(!haveFixtures)('probe — real files', () => {
  describe('video sources', () => {
    it.each(['av.mp4', 'av.mov', 'av.mkv', 'av.webm'])('%s is classified as video', async (f) => {
      const p = await profileOf(f);
      expect(p.mediaClass).toBe('video');
      expect(p.videoTracks.length).toBeGreaterThan(0);
    });

    it('reads video dimensions, not just the codec', async () => {
      const p = await profileOf('av.mp4');
      expect(p.videoTracks[0]?.codec).toBe('avc');
      expect(p.videoTracks[0]?.width).toBe(64);
      expect(p.videoTracks[0]?.height).toBe(64);
    });

    it('reads a numeric duration', async () => {
      const p = await profileOf('av.mp4');
      expect(p.durationSec).toBeGreaterThan(0);
      expect(Number.isFinite(p.durationSec!)).toBe(true);
    });

    it('reports whether the browser can decode the track', async () => {
      const p = await profileOf('av.mp4');
      expect(typeof p.videoTracks[0]?.decodable).toBe('boolean');
    });
  });

  describe('audio sources', () => {
    it('classifies an audio-only MP4 as audio, not video', async () => {
      // The container is ISO-BMFF either way; only the tracks settle it.
      const p = await profileOf('tone.m4a');
      expect(p.mediaClass).toBe('audio');
      expect(p.videoTracks).toHaveLength(0);
      expect(p.audioTracks.length).toBeGreaterThan(0);
    });

    it.each(['tone.mp3', 'tone.flac', 'tone.wav', 'tone.aac', 'tone-opus.ogg'])(
      '%s is classified as audio',
      async (f) => {
        const p = await profileOf(f);
        expect(p.mediaClass).toBe('audio');
      },
    );

    it('reads sample rate and channel count', async () => {
      const p = await profileOf('tone.wav');
      expect(p.audioTracks[0]?.sampleRate).toBe(44100);
      expect(p.audioTracks[0]?.channels).toBeGreaterThan(0);
    });

    it('reads Ogg Vorbis as audio', async () => {
      const p = await profileOf('tone-vorbis.ogg');
      expect(p.mediaClass).toBe('audio');
      expect(p.audioTracks[0]?.codec).toBe('vorbis');
    });
  });

  describe('images', () => {
    it('classifies a still JPEG and PNG as still images', async () => {
      expect((await profileOf('still.jpg')).mediaClass).toBe('still-image');
      expect((await profileOf('still.png')).mediaClass).toBe('still-image');
    });

    it('classifies a still WebP as a still image', async () => {
      expect((await profileOf('still.webp')).mediaClass).toBe('still-image');
    });

    it('classifies APNG as animated', async () => {
      // The container is plain PNG; only the acTL chunk reveals the animation.
      const p = await profileOf('anim.apng');
      expect(p.mediaClass).toBe('animated-image');
      expect(p.isAnimated).toBe(true);
    });

    it('classifies an animated GIF as animated', async () => {
      // A GIF misread as a still would hide every animation target from the user.
      const p = await profileOf('anim.gif');
      expect(p.mediaClass).toBe('animated-image');
    });

    it('classifies an animated WebP as animated', async () => {
      const p = await profileOf('anim.webp');
      expect(p.mediaClass).toBe('animated-image');
    });

    it('does not mistake a still PNG for an animation', async () => {
      expect((await profileOf('still.png')).isAnimated).toBe(false);
    });

    it('classifies a HEIC as a still image rather than giving up on it', async () => {
      const p = await profileOf('still.heic');
      expect(p.mediaClass).toBe('still-image');
      expect(p.container).toBe('isobmff-heic');
      // The card shows this, so it has to be a name a person recognises rather than the
      // box layout's.
      expect(describeProfile(p)).toBe('HEIC');
    });

    it('refuses a HEIF image sequence instead of silently exporting frame one', async () => {
      // Same container, different meaning: `hevc`/`hevx`/`msf1` brand a sequence, and
      // every decoder we have would hand back the first frame and say nothing about the
      // rest. The bytes are the real fixture with only the major brand swapped, so this
      // tests the branch rather than a mock of it.
      const sequence = new Uint8Array(readFileSync(join(FIXTURES, 'still.heic')));
      sequence.set(new TextEncoder().encode('hevx'), 8);

      const p = await probe(new Blob([sequence]), 'sequence.heics');
      expect(p.mediaClass).toBe('unknown');
      expect(p.unknownReason).toContain('序列');
    });
  });

  describe('Live Photo material', () => {
    it('reads the MOV pairing identifier without treating it as a Live Photo yet', async () => {
      // Detection of the *pair* is a separate step; alone, this is just a video.
      const p = await profileOf('livepair.mov');
      expect(p.mediaClass).toBe('video');
      expect(p.container).toBe('isobmff-mov');
    });
  });

  describe('robustness', () => {
    it('returns an unknown profile with a reason for junk, never throwing', async () => {
      const junk = new Blob([new TextEncoder().encode('definitely not media content here')]);
      const p = await probe(junk, 'junk.bin');
      expect(p.mediaClass).toBe('unknown');
      expect(p.unknownReason).toBeTruthy();
    });

    it('returns an unknown profile for an empty file', async () => {
      const p = await probe(new Blob([]), 'empty.bin');
      expect(p.mediaClass).toBe('unknown');
      expect(p.unknownReason).toBeTruthy();
    });

    it('ignores a misleading extension', async () => {
      // A PNG named .jpg must still be read as a PNG.
      const p = await probe(blobFor('still.png'), 'actually-not-a-jpeg.jpg');
      expect(p.container).toBe('png');
      expect(p.mediaClass).toBe('still-image');
    });

    it('produces a summary line for the UI', async () => {
      const p = await profileOf('av.mp4');
      expect(describeProfile(p)).toContain('AVC');
      expect(describeProfile(p)).toContain('64×64');
    });
  });
});

describe('probe — type-level guarantees', () => {
  it('every fixture maps to a known class', async () => {
    if (!haveFixtures) return;
    const files = ['still.jpg', 'still.png', 'anim.gif', 'av.mp4', 'tone.mp3', 'tone.wav'];
    for (const f of files) {
      const p = await profileOf(f);
      const valid: MediaClass[] = [
        'video',
        'animated-image',
        'still-image',
        'audio',
        'live-photo',
        'unknown',
      ];
      expect(valid).toContain(p.mediaClass);
    }
  });
});

/**
 * The probe must *always* answer.
 *
 * Not a stylistic preference: this function runs as the worker's reply to a card that is
 * already on screen, and the worker has no other way to answer. A rejection there is
 * caught by nothing, the caller's promise stays pending, and the card reads 「识别中」
 * for as long as the tab is open — with no error, no retry, and no way for the user to
 * tell it apart from the app having hung. These two cases are the ones the browser can
 * put us in through no fault of our own.
 */
describe('probe — always answers', () => {
  /** A file-shaped source whose reads fail, as a source whose backing store has gone does. */
  const unreadable = (name: string, size = 4096): Blob => {
    const fail = () => Promise.reject(new Error('NotReadableError: the file could not be read'));
    return { name, size, slice: () => ({ arrayBuffer: fail }), arrayBuffer: fail } as unknown as Blob;
  };

  it('names an unreadable source rather than rejecting', async () => {
    const p = await probe(unreadable('gone.mp4'), 'gone.mp4');
    expect(p.mediaClass).toBe('unknown');
    expect(p.unknownReason).toContain('无法读取');
    // Still a profile the card can describe, so the row does not go blank.
    expect(p.size).toBe(4096);
  });

});
