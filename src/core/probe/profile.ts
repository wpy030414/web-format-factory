import type { ContainerId, MediaClass } from '../types.ts';
import type { LivePhotoFlavor } from '../../livephoto/detect.ts';

/**
 * The shape of what we know about an input file.
 *
 * Kept free of any engine import on purpose: the UI, the router and the loss model all
 * need these types and the pure helpers below, but none of them should drag the media
 * library into the entry chunk. The code that actually *produces* a profile lives in
 * `probe.ts`, which only the worker imports.
 */

export interface VideoTrackInfo {
  codec: string;
  width: number;
  height: number;
  /** Rotation metadata in degrees, if any. */
  rotation?: number;
  /**
   * Can this browser actually decode it? Drives the `no-decoder-in-browser` refusal.
   *
   * Three states, not two. `false` is the browser refusing, which is an answer. `undefined`
   * is the browser not answering at all — a thing it does to a page it does not consider
   * visible — and it is *not* a refusal: reporting it as one silently closes routes the
   * machine can actually run, which is the exact failure the refusal exists to prevent.
   * See `DECODER_QUERY_MS` in `probe.ts`.
   */
  decodable?: boolean;
}

export interface AudioTrackInfo {
  codec: string;
  channels: number;
  sampleRate: number;
  /** Same three states as `VideoTrackInfo.decodable`, and for the same reason. */
  decodable?: boolean;
}

/**
 * Everything the pipeline knows about one input file.
 *
 * Produced once, then consumed by routing, loss annotation and the result report — so
 * the expensive parse happens a single time per file rather than per decision.
 */
export interface MediaProfile {
  name: string;
  size: number;
  container: ContainerId | 'unknown';
  brand?: string;
  docType?: string;
  mediaClass: MediaClass;

  videoTracks: VideoTrackInfo[];
  audioTracks: AudioTrackInfo[];
  /** Track types we neither use nor preserve. */
  otherTrackCount: number;

  durationSec?: number;
  /** More than one frame: APNG `acTL`, animated WebP, multi-frame GIF. */
  isAnimated?: boolean;
  /** Confirmed by an alpha-capable codec or an image format that supports it. */
  hasAlpha?: boolean;
  /**
   * Which Live Photo dialect this is, when the file turned out to be one.
   *
   * Just the name — the halves themselves are re-derived on demand from the bytes, which
   * is cheap, rather than shipped across the worker boundary inside every profile.
   */
  livePhotoFlavor?: LivePhotoFlavor;

  /**
   * Apple's pairing identifier, when the file carries one.
   *
   * Present on the video half of a Live Photo. Two files sharing a value here are a pair
   * beyond doubt, which is a far better basis for matching than filenames.
   */
  contentId?: string;

  /** Why the class is `unknown`, when it is — shown to the user verbatim. */
  unknownReason?: string;
}

/**
 * Readable names for containers that reach the summary line.
 *
 * Only the ones that get there: a file with tracks is described by its codecs, so this is
 * the image and audio-raw cases. Without it a HEIC reads as `isobmff-heic`, which is the
 * name of a box layout rather than of anything a person recognises.
 */
const CONTAINER_LABELS: Partial<Record<ContainerId, string>> = {
  jpeg: 'JPEG',
  png: 'PNG',
  webp: 'WebP',
  gif: 'GIF',
  'isobmff-heic': 'HEIC',
  zip: 'Live Photo 包',
};

/** Short human-readable summary, for file cards in the UI. */
export function describeProfile(profile: MediaProfile): string {
  const parts: string[] = [];
  const v = profile.videoTracks[0];
  const a = profile.audioTracks[0];
  if (v) parts.push(`${v.codec.toUpperCase()} ${v.width}×${v.height}`);
  if (a) parts.push(`${a.codec.toUpperCase()} ${a.sampleRate} Hz`);
  if (!v && !a && profile.container !== 'unknown') {
    parts.push(CONTAINER_LABELS[profile.container] ?? profile.container);
  }
  return parts.join(' · ');
}

/** Byte size, formatted for humans. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
