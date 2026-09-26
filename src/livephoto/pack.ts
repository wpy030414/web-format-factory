import { zipSync } from 'fflate';

import { sniff } from '../core/probe/sniff.ts';
import { detectMotionPhoto, unpackLivp } from './detect.ts';
import { buildMotionPhotoXmp, writeXmp } from './xmp.ts';

/**
 * Live Photo packaging.
 *
 * Two rules shape everything here:
 *
 * 1. **Verify what we produced.** Every function ends by re-reading its own output with
 *    the corresponding detector. A Live Photo that looks right and cannot be opened is
 *    the worst possible outcome, and the check is cheap because the detectors already
 *    exist.
 * 2. **Never claim more than we did.** Where a piece of the format is not implemented,
 *    the caller gets told rather than getting a file that silently lacks it.
 */

export interface MotionPhotoOptions {
  presentationTimestampUs?: number;
}

export interface PackResult {
  bytes: Uint8Array;
  /** Anything we could not do. Empty when the output is complete. */
  warnings: string[];
}

/**
 * Build a Google Motion Photo: a still JPEG with the video appended and XMP tying the
 * two together.
 *
 * Neither half is re-encoded — the still's bytes and the video's bytes are used as given
 * — so this is lossless with respect to both.
 */
export function buildMotionPhoto(
  stillJpeg: Uint8Array,
  video: Uint8Array,
  options: MotionPhotoOptions = {},
): PackResult {
  const warnings: string[] = [];

  if (video.length === 0) throw new Error('没有可附加的视频');

  // The offset is counted from the end of the file, so it is exactly the video's length
  // and can be written before we know the final size. Getting this backwards — treating
  // it as an offset from the start — produces a file whose "video" is a slice of JPEG.
  const xmp = buildMotionPhotoXmp({
    videoLength: video.length,
    ...(options.presentationTimestampUs !== undefined
      ? { presentationTimestampUs: options.presentationTimestampUs }
      : {}),
  });

  const taggedStill = writeXmp(stillJpeg, xmp);
  const bytes = concat([taggedStill, video]);

  // Verify by re-reading our own output. The check that matters is not "did we write an
  // XMP packet" but "does the offset land on a video container" — and that is exactly
  // what the detector tests.
  const readBack = detectMotionPhoto(bytes, 'jpeg');
  if (!readBack) {
    throw new Error('封装后的文件未能通过自校验：无法识别为 Motion Photo');
  }
  if (readBack.video.bytes.length !== video.length) {
    throw new Error(
      `封装后的文件未能通过自校验：视频长度不符（期望 ${video.length}，读回 ${readBack.video.bytes.length}）`,
    );
  }

  return { bytes, warnings };
}

/**
 * Package an Apple Live Photo pair as a `.livp`.
 *
 * The archive is stored uncompressed on purpose: both members are already compressed, so
 * deflating them buys nothing measurable while costing time on large videos.
 */
export function buildLivp(still: Uint8Array, video: Uint8Array): PackResult {
  const warnings: string[] = [];

  // Name the entries by content, matching how the file will be read back.
  const stillIsHeic = sniff(still.subarray(0, 64)).container === 'isobmff-heic';
  const bytes = zipSync(
    {
      [`live.${stillIsHeic ? 'heic' : 'jpg'}`]: [still, { level: 0 }],
      'live.mov': [video, { level: 0 }],
    },
    { level: 0 },
  );

  const readBack = unpackLivp(bytes);
  if (!readBack) {
    throw new Error('封装后的 .livp 未能通过自校验：无法解包出静图与视频');
  }

  return { bytes, warnings };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
