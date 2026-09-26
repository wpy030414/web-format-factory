import { describe, expect, it } from 'vitest';
import { classify, MEDIA_CLASS_LABELS } from '@/core/probe/classify.ts';
import type { ContainerId } from '@/core/types.ts';

describe('classify — deciding what a file is', () => {
  it('treats an MP4 with a video track as video', () => {
    expect(classify({ container: 'isobmff-mp4', hasVideoTrack: true, hasAudioTrack: true })).toBe(
      'video',
    );
  });

  it('treats an MP4 carrying only audio as audio, not video', () => {
    // M4A is an MP4 with an audio-only track set. Calling it video would offer the user
    // targets that cannot possibly work.
    expect(classify({ container: 'isobmff-mp4', hasAudioTrack: true })).toBe('audio');
    expect(classify({ container: 'isobmff-m4a', hasAudioTrack: true })).toBe('audio');
  });

  it('treats a tracked container with no usable tracks as unknown, with no guess', () => {
    expect(classify({ container: 'isobmff-mp4' })).toBe('unknown');
    expect(classify({ container: 'matroska' })).toBe('unknown');
  });

  it('separates still from animated for image containers', () => {
    expect(classify({ container: 'png' })).toBe('still-image');
    expect(classify({ container: 'png', isAnimated: true })).toBe('animated-image');
    expect(classify({ container: 'gif', isAnimated: true })).toBe('animated-image');
    expect(classify({ container: 'gif', isAnimated: false })).toBe('still-image');
    expect(classify({ container: 'webp', isAnimated: true })).toBe('animated-image');
  });

  it('treats HEIC as a picture, not as a track container', () => {
    // HEIC shares ISO-BMFF with MP4 but carries a `meta` box rather than tracks. Leaving
    // it out of the image containers sends it down the "no usable tracks" path to
    // `unknown`, which hides every target — and HEIC → JPEG is the most valuable
    // conversion this tool performs, because it is what every recent iPhone writes.
    expect(classify({ container: 'isobmff-heic' })).toBe('still-image');
  });

  it('lets a confirmed Live Photo outrank its container', () => {
    // A Motion Photo is a JPEG that is also a bundle; the bundle wins.
    expect(classify({ container: 'jpeg', isLivePhoto: true })).toBe('live-photo');
    expect(classify({ container: 'zip', isLivePhoto: true })).toBe('live-photo');
    expect(classify({ container: 'isobmff-mov', isLivePhoto: true })).toBe('live-photo');
  });

  it('identifies plain audio containers', () => {
    for (const c of ['mp3', 'adts', 'flac', 'wav'] as ContainerId[]) {
      expect(classify({ container: c })).toBe('audio');
    }
  });

  it('settles Ogg by its tracks, because it can carry video too', () => {
    // `.ogv` is a real thing. Assuming Ogg means audio would misclassify it.
    expect(classify({ container: 'ogg', hasAudioTrack: true })).toBe('audio');
    expect(classify({ container: 'ogg', hasVideoTrack: true, hasAudioTrack: true })).toBe('video');
  });

  it('does not guess when the container is unrecognised', () => {
    expect(classify({ container: 'unknown' })).toBe('unknown');
    expect(classify({ container: 'zip' })).toBe('unknown');
  });

  it('has a label for every class', () => {
    for (const cls of [
      'video',
      'animated-image',
      'still-image',
      'audio',
      'live-photo',
      'unknown',
    ] as const) {
      expect(MEDIA_CLASS_LABELS[cls]).toBeTruthy();
    }
  });
});
