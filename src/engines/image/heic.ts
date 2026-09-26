import { EngineError } from '../types.ts';

/**
 * HEIC decoding.
 *
 * Only Safari can decode HEIC with `createImageBitmap`. Everywhere else the call throws,
 * which would mean a HEIC dropped into Chrome offers no targets at all — and HEIC is what
 * every recent iPhone writes by default, so that is the single most valuable conversion
 * this tool can perform.
 *
 * The decoder is a build of libheif compiled to WebAssembly, ~3 MB, loaded on first use
 * and kept for the session. It is deliberately the last thing tried: when the browser can
 * decode HEIC itself we never fetch it, which is the common case on Apple hardware where
 * HEIC originates.
 *
 * The package ships the WASM inlined in its own bundle and runs it in a worker of its own.
 * That extra hop costs one structured clone of the decoded pixels, and buys a decoder we
 * cannot get wrong: no `locateFile` wiring, no MIME type to configure, no separate asset
 * to keep in step with the build.
 */

type HeicTo = (args: {
  blob: Blob;
  type: 'bitmap';
  options?: ImageBitmapOptions;
}) => Promise<ImageBitmap>;

let pending: Promise<HeicTo> | null = null;

async function loadDecoder(): Promise<HeicTo> {
  pending ??= import('heic-to').then((module) => module.heicTo);

  try {
    return await pending;
  } catch (cause) {
    // Do not cache a failure: a transient network error on the first HEIC should not
    // disable the decoder for the rest of the session.
    pending = null;
    throw new EngineError(
      `无法加载 HEIC 解码器（约 3 MB）：${(cause as Error).message}`,
      'engine-unavailable',
    );
  }
}

/**
 * Decode a HEIC to an upright bitmap.
 *
 * Orientation is libheif's business here rather than ours: a HEIC stores rotation as an
 * `irot` property and libheif applies it while decoding, so there is no EXIF tag left for
 * us to bake in the way there is for JPEG. A rotated iPhone photograph therefore comes out
 * the right way up without this code doing anything.
 */
export async function decodeHeic(blob: Blob): Promise<ImageBitmap> {
  const heicTo = await loadDecoder();

  try {
    return await heicTo({ blob, type: 'bitmap' });
  } catch (cause) {
    throw new EngineError(`无法解码这个 HEIC 文件：${(cause as Error).message}`, 'decode-failed');
  }
}

/** Has the decoder already been fetched? Reported by the capability probe. */
export function heicDecoderLoaded(): boolean {
  return pending !== null;
}
