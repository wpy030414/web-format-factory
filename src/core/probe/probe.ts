import { ALL_FORMATS, BlobSource, Input, type InputTrack } from 'mediabunny';

import type { ContainerId } from '../types.ts';
import { withDeadline } from '../deadline.ts';
import { detectMotionPhoto, unpackLivp } from '../../livephoto/detect.ts';
import { extractXmp } from '../../livephoto/xmp.ts';
import { classify } from './classify.ts';
import type { AudioTrackInfo, MediaProfile, VideoTrackInfo } from './profile.ts';
import {
  HEIC_SEQUENCE_BRANDS,
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
 * How long a decoder-capability query may take before we stop waiting for it.
 *
 * `canDecode` is the probe's one call into the browser's media pipeline — everything else
 * here is arithmetic on bytes we already hold. The media pipeline is torn down for a page
 * the browser does not consider visible, and the query does not fail when that happens;
 * it never answers. An honest answer takes single-digit milliseconds, so five seconds is
 * several hundred times the real cost: it is sized so that a merely slow machine still
 * gets its answer, and only a pipeline that has stopped talking at all runs out of time.
 *
 * What a timeout produces matters more than the number. It produces `undefined` — "not
 * established" — and deliberately *not* `false`. `false` is the browser refusing, and it
 * shuts routes through `decoderDoor`; answering it for a question nobody answered would
 * quietly remove conversions this machine can run, with a reason that is not true. The
 * cost of the honest answer is at worst one option that fails late with the engine's own
 * error; the cost of the dishonest one is an option that never appears.
 */
const DECODER_QUERY_MS = 5000;

/** The message from whatever was thrown, which is a string more often than an Error. */
function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === 'string' && cause.trim()) return cause;
  return '未知原因';
}

/**
 * Probe a file: identify its container by content, then read its track structure.
 *
 * Extensions are never consulted, and a failure to parse is not an error — it yields a
 * profile with `unknown` class and a reason, because "we could not identify this" is a
 * legitimate outcome the UI must be able to explain.
 *
 * That is a promise this function has to keep absolutely, because of where it runs: the
 * worker's message handler has no other way to answer. A rejection there is caught by
 * nothing, and the caller's promise stays pending for good — the card sits at 「识别中」
 * with no error, no retry and nothing to click, which is indistinguishable from the app
 * having hung. The parsing below already returns reasons instead of throwing; this
 * wrapper covers the one step that is out of our hands, reading the bytes at all. A
 * source whose backing store has gone, or an allocation that did not fit, fails *here*.
 */
export async function probe(file: File | Blob, name = 'file'): Promise<MediaProfile> {
  try {
    return await identify(file, name);
  } catch (cause) {
    return {
      name,
      size: file.size,
      container: 'unknown',
      mediaClass: 'unknown',
      videoTracks: [],
      audioTracks: [],
      otherTrackCount: 0,
      unknownReason: `无法读取这个文件：${messageOf(cause)}`,
    };
  }
}

/** The identification proper. Permitted to reject; `probe` is what turns that into a profile. */
async function identify(file: File | Blob, name: string): Promise<MediaProfile> {
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

  // A `.livp` is a ZIP of a still and a MOV. It is checked before anything else because
  // its container says nothing about what the file actually is.
  if (sniffed.container === 'zip') {
    const archive = unpackLivp(await readAll(file));
    if (!archive) {
      return { ...base, unknownReason: '这个压缩包里没有找到配对的静图与视频。' };
    }
    return {
      ...base,
      mediaClass: 'live-photo',
      livePhotoFlavor: archive.flavor,
      ...(archive.issues.length > 0 ? { unknownReason: archive.issues.join('；') } : {}),
    };
  }

  // A Google Motion Photo is a JPEG that is also a container. Its XMP claims are checked
  // against the bytes before we believe them.
  if (sniffed.container === 'jpeg') {
    const motion = detectMotionPhoto(await readAll(file), 'jpeg');
    if (motion) {
      return {
        ...base,
        mediaClass: 'live-photo',
        livePhotoFlavor: motion.flavor,
      };
    }
  }

  // A JPEG can still be the still half of an Apple pair, carrying the shared identifier
  // in its XMP. Without reading it here, pairing would fall back to filenames for the
  // very format both halves were designed to be matched by.
  if (sniffed.container === 'jpeg') {
    const stillId = readStillIdentifier(head);
    if (stillId) {
      return {
        ...base,
        mediaClass: 'still-image',
        hasAlpha: false,
        contentId: stillId,
      };
    }
  }

  // A HEIC *sequence* is not a still with a hidden extra, it is an animation we cannot
  // take apart — `createImageBitmap` would quietly hand back frame one. Saying so beats
  // exporting one frame of a short video and calling it a photograph.
  if (sniffed.container === 'isobmff-heic' && HEIC_SEQUENCE_BRANDS.has(sniffed.brand ?? '')) {
    return {
      ...base,
      unknownReason: '这是一个 HEIF 图像序列，本项目只能处理单帧的 HEIC 图片。',
    };
  }

  // Images carry their own metadata rather than a track structure.
  if (
    sniffed.container === 'png' ||
    sniffed.container === 'gif' ||
    sniffed.container === 'jpeg' ||
    sniffed.container === 'webp' ||
    sniffed.container === 'isobmff-heic'
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

    // Apple tags the video half of a Live Photo with an identifier. Reading it here costs
    // one metadata lookup on files we are already parsing, and it is what lets us pair a
    // dropped still with its video on evidence rather than on a filename guess.
    const contentId = await readContentIdentifierFrom(input);

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
      ...(contentId ? { contentId } : {}),
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

/** Read a whole file into memory. Used only by the Live Photo paths, which need the
 * trailing bytes that a sniff window never reaches. */
async function readAll(file: File | Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
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

/**
 * Apple's pairing identifier on a still image.
 *
 * Written into the XMP packet, under the `apple` namespace. A still that carries it and a
 * MOV that carries the same value are a pair on evidence rather than on a name.
 */
function readStillIdentifier(head: Uint8Array): string | undefined {
  const xmp = extractXmp(head);
  if (!xmp) return undefined;
  const match = xmp.match(/apple:ContentIdentifier\s*=\s*"([^"]+)"/);
  return match?.[1];
}

/** Apple's pairing identifier, if this file carries one. */
async function readContentIdentifierFrom(input: Input): Promise<string | undefined> {
  try {
    const tags = await input.getMetadataTags();
    const value = tags.raw?.['com.apple.quicktime.content.identifier'];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return undefined;
  } catch {
    // No metadata, or nothing readable — either way there is no identifier.
    return undefined;
  }
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
  // Two different failures, kept apart: `.catch` handles the browser *refusing* ("no"),
  // and the deadline handles it going quiet ("no answer"). See DECODER_QUERY_MS.
  const decodable = await withDeadline(
    v.canDecode(),
    DECODER_QUERY_MS,
    () => undefined,
  ).catch(() => false);
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
  // Same two failures as the video track's, kept apart the same way — see DECODER_QUERY_MS.
  const decodable = await withDeadline(
    a.canDecode(),
    DECODER_QUERY_MS,
    () => undefined,
  ).catch(() => false);
  return { codec, channels, sampleRate, decodable };
}
