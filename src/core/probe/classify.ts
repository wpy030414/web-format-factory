import type { ContainerId, MediaClass } from '../types.ts';

/** Containers that hold a single still, or a sequence of frames, but no track structure. */
const IMAGE_CONTAINERS: ReadonlySet<ContainerId> = new Set<ContainerId>([
  'jpeg',
  'png',
  'webp',
  'gif',
]);

/**
 * Containers with a track structure: an mp4 holding only audio is audio, not video.
 *
 * `ogg` belongs here rather than among the plain audio containers because it can carry
 * video too (Theora). Assuming an Ogg file is audio would misclassify `.ogv`.
 */
const TRACKED_CONTAINERS: ReadonlySet<ContainerId> = new Set<ContainerId>([
  'isobmff-mp4',
  'isobmff-mov',
  'isobmff-m4a',
  'matroska',
  'webm',
  'ogg',
]);

/** Containers that hold audio and nothing else, by construction. */
const AUDIO_CONTAINERS: ReadonlySet<ContainerId> = new Set<ContainerId>([
  'mp3',
  'adts',
  'flac',
  'wav',
]);

/** Everything the classifier needs. All optional except the container. */
export interface ClassifyInput {
  container: ContainerId | 'unknown';
  /** Did the container report a video track? */
  hasVideoTrack?: boolean;
  /** Did the container report an audio track? */
  hasAudioTrack?: boolean;
  /** More than one frame (APNG `acTL`, animated WebP `ANIM`, multi-frame GIF). */
  isAnimated?: boolean;
  /** Confirmed Live Photo: a pairing identifier, or a Motion Photo with a real video. */
  isLivePhoto?: boolean;
}

/**
 * Decide what a file *is*.
 *
 * Runs after the container probe, because the container alone is not enough: the same
 * MP4 can be a video or an audio-only file, and the same JPEG can be a still or half of
 * a Google Motion Photo. Anything we cannot determine stays `unknown` rather than being
 * guessed at — a wrong class sends the router down a path that cannot succeed.
 */
export function classify(input: ClassifyInput): MediaClass {
  const { container } = input;

  if (container === 'unknown') return 'unknown';

  // A Live Photo is a bundle, and outranks whatever its container suggests.
  if (input.isLivePhoto) return 'live-photo';

  if (IMAGE_CONTAINERS.has(container)) {
    // A single-frame GIF or APNG is still handled by the animation path — the format
    // requires the machinery either way — but a one-frame file reads better as a still.
    return input.isAnimated ? 'animated-image' : 'still-image';
  }

  if (TRACKED_CONTAINERS.has(container)) {
    if (input.hasVideoTrack) return 'video';
    // An MP4 or MOV carrying only an audio track is an audio file. Treating it as
    // video would offer the user targets that cannot work.
    if (input.hasAudioTrack) return 'audio';
    return 'unknown';
  }

  if (AUDIO_CONTAINERS.has(container)) return 'audio';

  // `zip` is only ever a Live Photo container, and only once unpacked and verified.
  return 'unknown';
}

/** Human-readable label for the UI. */
export const MEDIA_CLASS_LABELS: Record<MediaClass, string> = {
  video: '视频',
  'animated-image': '动图',
  'still-image': '静态图像',
  audio: '音频',
  'live-photo': 'Live Photo',
  unknown: '无法识别',
};
