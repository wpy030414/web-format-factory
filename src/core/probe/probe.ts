import { ALL_FORMATS, BlobSource, Input, type InputTrack } from 'mediabunny';

import type { ContainerId } from '../types.ts';
import { classify } from './classify.ts';
import type { AudioTrackInfo, MediaProfile, VideoTrackInfo } from './profile.ts';
import {
  imageHasAlpha,
  isAnimatedGif,
  isAnimatedWebp,
  isApng,
  sniff,
  SNIFF_BYTES,
} from './sniff.ts';

/**
 * The engine-backed probe.
 *
 * This module imports the media library, so it is deliberately only reachable from the
 * worker — importing it from UI code would pull the whole parser into the entry chunk.
 * Types and pure helpers live in `profile.ts` for that reason.
 */

/** Read at most this many bytes for the initial sniff. */
const SNIFF_WINDOW = SNIFF_BYTES;

/**
 * Animation detection needs to see past the first frame, which can itself be large.
 * The sniff window is deliberately small, so an image container gets a second, wider
 * read before we conclude it holds only one frame.
 */
const ANIMATION_WINDOW = 4 * 1024 * 1024;

/**
 * Probe a file: identify its container by content, then read its track structure.
 *
 * Extensions are never consulted, and a failure to parse is not an error — it yields a
 * profile with `unknown` class and a reason, because "we could not identify this" is a
 * legitimate outcome the UI must be able to explain.
 */
export async function probe(file: File | Blob, name = 'file'): Promise<MediaProfile> {
  const head = new Uint8Array(await file.slice(0, SNIFF_WINDOW).arrayBuffer());
  const sniffed = sniff(head);

  const base: MediaProfile = {
    name,
    size: file.size,
    container: sniffed.container,
    ...(sniffed.brand ? { brand: sniffed.brand } : {}),
    ...(sniffed.docType ? { docType: sniffed.docType } : {}),
    mediaClass: 'unknown',
    videoTracks: [],
    audioTracks: [],
    otherTrackCount: 0,
  };

  if (sniffed.container === 'unknown') {
    return { ...base, unknownReason: '无法从文件内容识别出容器格式。' };
  }

  // Images carry their own metadata rather than a track structure.
  if (
    sniffed.container === 'png' ||
    sniffed.container === 'gif' ||
    sniffed.container === 'jpeg' ||
    sniffed.container === 'webp'
  ) {
    const isAnimated = await detectAnimation(file, sniffed.container, head);
    return {
      ...base,
      ...(isAnimated !== undefined ? { isAnimated } : {}),
      // Detected from the container bytes, so a transparent PNG converted to JPEG
      // raises a critical warning instead of silently turning transparent areas white.
      hasAlpha: imageHasAlpha(head, sniffed.container),
      mediaClass: classify({
        container: sniffed.container,
        ...(isAnimated !== undefined ? { isAnimated } : {}),
      }),
    };
  }

  // Everything else has a track structure worth reading.
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const [videoTracks, audioTracks, allTracks] = await Promise.all([
      input.getVideoTracks(),
      input.getAudioTracks(),
      input.getTracks(),
    ]);

    const video = await Promise.all(videoTracks.map(readVideoTrack));
    const audio = await Promise.all(audioTracks.map(readAudioTrack));
    const duration = await input.computeDuration().catch(() => undefined);

    const mediaClass = classify({
      container: sniffed.container,
      hasVideoTrack: video.length > 0,
      hasAudioTrack: audio.length > 0,
    });

    return {
      ...base,
      mediaClass,
      videoTracks: video,
      audioTracks: audio,
      otherTrackCount: Math.max(0, allTracks.length - video.length - audio.length),
      ...(duration !== undefined && Number.isFinite(duration) ? { durationSec: duration } : {}),
      ...(mediaClass === 'unknown'
        ? { unknownReason: '容器可识别，但其中没有可用的音视频轨道。' }
        : {}),
    };
  } catch (cause) {
    // A parse failure is a fact about the file, not a crash.
    return { ...base, unknownReason: `容器解析失败：${(cause as Error).message}` };
  }
}

/**
 * Is this image container animated?
 *
 * Returns `undefined` for formats that cannot animate, so the caller can tell
 * "definitely not animated" apart from "we did not check".
 */
async function detectAnimation(
  file: File | Blob,
  container: ContainerId,
  head: Uint8Array,
): Promise<boolean | undefined> {
  if (container === 'jpeg') return undefined;

  const check = (bytes: Uint8Array): boolean => {
    if (container === 'png') return isApng(bytes);
    if (container === 'gif') return isAnimatedGif(bytes);
    if (container === 'webp') return isAnimatedWebp(bytes);
    return false;
  };

  if (check(head)) return true;

  // Not found in the sniff window. For a large first frame the second one may sit
  // beyond it, so widen the read before concluding "still".
  if (file.size > head.byteLength) {
    const wider = new Uint8Array(
      await file.slice(0, Math.min(file.size, ANIMATION_WINDOW)).arrayBuffer(),
    );
    return check(wider);
  }

  return false;
}

async function readVideoTrack(track: InputTrack): Promise<VideoTrackInfo> {
  // `squarePixel*` rather than `coded*`: the former accounts for a non-1:1 pixel aspect
  // ratio, so it is the size the picture actually displays at.
  const v = track as unknown as {
    getCodec(): Promise<string | null>;
    getSquarePixelWidth(): Promise<number>;
    getSquarePixelHeight(): Promise<number>;
    getCodedWidth(): Promise<number>;
    getCodedHeight(): Promise<number>;
    getRotation(): Promise<number>;
    canDecode(): Promise<boolean>;
  };
  const codec = (await v.getCodec().catch(() => null)) ?? 'unknown';
  const width = await v.getSquarePixelWidth().catch(() => v.getCodedWidth().catch(() => 0));
  const height = await v.getSquarePixelHeight().catch(() => v.getCodedHeight().catch(() => 0));
  const rotation = await v.getRotation().catch(() => 0);
  const decodable = await v.canDecode().catch(() => false);
  return {
    codec,
    width,
    height,
    ...(rotation ? { rotation } : {}),
    decodable,
  };
}

async function readAudioTrack(track: InputTrack): Promise<AudioTrackInfo> {
  const a = track as unknown as {
    getCodec(): Promise<string | null>;
    getNumberOfChannels(): Promise<number>;
    getSampleRate(): Promise<number>;
    canDecode(): Promise<boolean>;
  };
  const codec = (await a.getCodec().catch(() => null)) ?? 'unknown';
  const channels = await a.getNumberOfChannels().catch(() => 0);
  const sampleRate = await a.getSampleRate().catch(() => 0);
  const decodable = await a.canDecode().catch(() => false);
  return { codec, channels, sampleRate, decodable };
}
