import { unzipSync } from 'fflate';

import { sniff } from '../core/probe/sniff.ts';
import type { ContainerId } from '../core/types.ts';
import { extractXmp, readContainerMotionPhotoLength, readXmpNumber } from './xmp.ts';

/**
 * Live Photo identification.
 *
 * The awkward part of this format is that it is not one format: Apple pairs a still with
 * a MOV and shares an identifier, Google appends a video to a still inside a single file,
 * and `.livp` is just a ZIP of the Apple pair. Each is detected differently.
 *
 * Everything here works on bytes alone and imports no media library, so the pairing
 * helpers are safe to use from the UI — pulling the parser into the entry chunk just to
 * zip two halves together would be a poor trade. Reading the identifier *out of* a MOV
 * does need the library, and lives in the probe instead.
 */

export type LivePhotoFlavor =
  | 'apple-livp'
  | 'apple-paired'
  | 'google-motionphoto-jpeg'
  | 'google-motionphoto-heif';

export interface MediaHalf {
  bytes: Uint8Array;
  /** For the still half, whether it is HEIC or JPEG. */
  stillFormat?: 'heic' | 'jpeg';
  /** For the video half, its container. */
  videoContainer?: ContainerId;
  /** Apple's pairing identifier, when present. */
  contentId?: string;
}

export interface LivePhotoInfo {
  flavor: LivePhotoFlavor;
  still: MediaHalf;
  video: MediaHalf;
  /** The still's XMP presentation timestamp, when the file declares one. */
  presentationTimestampUs?: number;
  /**
   * Things we noticed but could not act on. Surfaced to the user rather than swallowed —
   * a Live Photo that is subtly wrong is worse than one that is openly incomplete.
   */
  issues: string[];
}

/* ------------------------------------------------------------- Google: one file */

/**
 * Detect a Google Motion Photo.
 *
 * The XMP marker alone is not enough: `Camera:MotionPhoto` survives in files whose video
 * has since been stripped by another tool, so a stale offset is common. Every claim is
 * checked against the actual bytes before we believe it.
 */
export function detectMotionPhoto(bytes: Uint8Array, container: ContainerId): LivePhotoInfo | null {
  if (container !== 'jpeg') return null;

  const xmp = extractXmp(bytes);
  if (!xmp) return null;

  const declaresMotionPhoto =
    /Camera:MotionPhoto\s*=\s*"1"/.test(xmp) || /Camera:MicroVideo\s*=\s*"1"/.test(xmp);
  if (!declaresMotionPhoto) return null;

  // Prefer the modern container form; fall back to the legacy key.
  const declared =
    readContainerMotionPhotoLength(xmp) ?? readXmpNumber(xmp, 'Camera:MicroVideoOffset');

  if (declared === undefined || declared <= 0 || declared >= bytes.length) {
    // The marker is there but the offset is not usable. Report it as a plain JPEG with a
    // note rather than as a Live Photo we cannot actually split.
    return null;
  }

  const stillEnd = bytes.length - declared;
  const videoBytes = bytes.subarray(stillEnd);

  // The load-bearing check. If the offset does not land on a video container, the file is
  // not a Motion Photo any more, whatever its XMP says.
  const videoContainer = sniff(videoBytes.subarray(0, 64)).container;
  if (videoContainer === 'unknown') return null;

  const presentationTimestampUs =
    readXmpNumber(xmp, 'Camera:MotionPhotoPresentationTimestampUs') ??
    readXmpNumber(xmp, 'Camera:MicroVideoPresentationTimestampUs');

  return {
    flavor: 'google-motionphoto-jpeg',
    still: { bytes: bytes.subarray(0, stillEnd), stillFormat: 'jpeg' },
    video: { bytes: videoBytes, videoContainer },
    ...(presentationTimestampUs !== undefined ? { presentationTimestampUs } : {}),
    issues: [],
  };
}

/* ------------------------------------------------------------- Apple: a ZIP (.livp) */

export function isLivpZip(bytes: Uint8Array): boolean {
  return sniff(bytes).container === 'zip';
}

/**
 * Unpack a `.livp`.
 *
 * The archive holds one still and one MOV. Apple's own exports name them after a shared
 * stem, but we go by content rather than by name — the same rule as everywhere else.
 */
export function unpackLivp(bytes: Uint8Array): LivePhotoInfo | null {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return null;
  }

  let still: MediaHalf | undefined;
  let video: MediaHalf | undefined;
  const issues: string[] = [];

  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue;
    const head = data.subarray(0, 64);
    const container = sniff(head).container;

    if (container === 'isobmff-mov' || container === 'isobmff-mp4') {
      video ??= { bytes: data, videoContainer: container };
    } else if (container === 'isobmff-heic') {
      still ??= { bytes: data, stillFormat: 'heic' };
    } else if (container === 'jpeg') {
      still ??= { bytes: data, stillFormat: 'jpeg' };
    } else {
      issues.push(`压缩包里有一项无法识别：${name}`);
    }
  }

  if (!still || !video) {
    issues.push('压缩包里缺少静图或视频，这不像是一个 Live Photo。');
    return null;
  }

  return { flavor: 'apple-livp', still, video, issues };
}

/**
 * Pair a batch of dropped files into Live Photos.
 *
 * Matching goes by content identifier first, because that is what the format actually
 * guarantees. Filename stems are a fallback for pairs whose identifiers were stripped,
 * and a user confirmation belongs on top of either — see the UI's pairing affordance.
 */
export interface PairingCandidate {
  name: string;
  bytes: Uint8Array;
  container: ContainerId | 'unknown';
  contentId?: string;
}

export interface PairedGroup {
  still: PairingCandidate;
  video: PairingCandidate;
  /** How the two were matched, so the UI can say how confident it is. */
  matchedBy: 'identifier' | 'filename';
}

export function pairLivePhotos(candidates: readonly PairingCandidate[]): PairedGroup[] {
  const stills = candidates.filter(
    (c) => c.container === 'jpeg' || c.container === 'isobmff-heic',
  );
  const videos = candidates.filter(
    (c) => c.container === 'isobmff-mov' || c.container === 'isobmff-mp4',
  );

  const groups: PairedGroup[] = [];
  const usedVideos = new Set<PairingCandidate>();

  // Pass one: exact identifier matches.
  for (const still of stills) {
    if (!still.contentId) continue;
    const match = videos.find((v) => v.contentId === still.contentId && !usedVideos.has(v));
    if (!match) continue;
    usedVideos.add(match);
    groups.push({ still, video: match, matchedBy: 'identifier' });
  }

  // Pass two: filename stems, for pairs that lost their identifiers along the way.
  for (const still of stills) {
    if (groups.some((g) => g.still === still)) continue;
    const stem = stemOf(still.name);
    const match = videos.find((v) => stemOf(v.name) === stem && !usedVideos.has(v));
    if (!match) continue;
    usedVideos.add(match);
    groups.push({ still, video: match, matchedBy: 'filename' });
  }

  return groups;
}

function stemOf(name: string): string {
  return name.replace(/\.[^./\\]+$/, '').toLowerCase();
}
