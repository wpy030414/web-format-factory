import { getFormat } from '../../core/registry/formats.ts';
import { sniff } from '../../core/probe/sniff.ts';
import type { FormatId } from '../../core/types.ts';
import { decodeHeic } from './heic.ts';
import {
  EngineError,
  outputNameFor,
  qualityFraction,
  type Engine,
  type EngineRequest,
  type EngineResult,
} from '../types.ts';

/**
 * The still-image engine.
 *
 * Uses only browser primitives — no WASM, no download. This is the fastest path for
 * every raster format the browser can already decode, which today is JPEG, PNG and WebP
 * everywhere, plus HEIC on Safari. A HEIC anywhere else is handled by a lazily loaded
 * decoder; see ./heic.ts.
 */

interface ImageTarget {
  mime: string;
  /** Does this encoder take a quality knob? */
  takesQuality: boolean;
  /**
   * Does the format lack an alpha channel?
   *
   * This matters more than it looks: when the browser encodes to a format without
   * alpha it composites onto **black**, not white, so a transparent logo becomes a
   * black square. We fill the canvas ourselves first.
   */
  lacksAlpha: boolean;
}

const TARGETS: Partial<Record<FormatId, ImageTarget>> = {
  jpeg: { mime: 'image/jpeg', takesQuality: true, lacksAlpha: true },
  png: { mime: 'image/png', takesQuality: false, lacksAlpha: false },
  webp: { mime: 'image/webp', takesQuality: true, lacksAlpha: false },
};

/** What the flattened background is, stated so the loss copy can name it. */
const FLATTEN_BACKGROUND = '#ffffff';

export class ImageEngine implements Engine {
  readonly id = 'image';

  supports(target: FormatId): boolean {
    return target in TARGETS;
  }

  /**
   * Can this browser decode this blob as an image?
   *
   * Used to route around formats the engine cannot read rather than failing mid-job.
   */
  async canDecode(blob: Blob): Promise<boolean> {
    try {
      const bitmap = await createImageBitmap(blob);
      bitmap.close();
      return true;
    } catch {
      return false;
    }
  }

  async run(request: EngineRequest): Promise<EngineResult> {
    const { input, target, params } = request;

    const spec = TARGETS[target];
    if (!spec) throw new EngineError(`no image encoder for ${target}`, 'unsupported');

    const bitmap = await decode(input);

    try {
      const quality = qualityFraction(params.quality, 0.9);
      const output = await encode(bitmap, spec, quality);
      const targetSpec = getFormat(target);

      return {
        output,
        outputName: outputNameFor(request.inputName, targetSpec.extension),
        engineId: this.id,
        // Re-encoding an image always produces new compressed bytes; there is no
        // "copy the payload" path through a canvas.
        did: 'transcode',
      };
    } finally {
      // Frames are the classic leak in canvas code — close it on every path, including
      // the error one.
      bitmap.close();
    }
  }
}

/**
 * Decode to pixels, upright.
 *
 * `imageOrientation: 'from-image'` is not optional: `drawImage` ignores the EXIF
 * orientation tag, so a portrait photo shot on a phone would come out sideways. Baking
 * the rotation here and dropping the tag downstream is the only way to avoid either
 * a rotated result or a double rotation.
 */
async function decode(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (nativeFailure) {
    // Only Safari decodes HEIC with the built-in path. The container is checked from the
    // bytes rather than by asking the decoder package, so no HEIC means no 3 MB download.
    if (await isHeic(blob)) return decodeHeic(blob);

    throw new EngineError(
      `无法解码这张图片：${(nativeFailure as Error).message}`,
      'decode-failed',
    );
  }
}

async function isHeic(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  return sniff(head).container === 'isobmff-heic';
}

async function encode(bitmap: ImageBitmap, spec: ImageTarget, quality: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new EngineError('无法创建绘图上下文', 'encode-failed');

  if (spec.lacksAlpha) {
    // Fill before drawing. Skipping this composites transparency onto black.
    ctx.fillStyle = FLATTEN_BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.drawImage(bitmap, 0, 0);

  try {
    return await canvas.convertToBlob({
      type: spec.mime,
      ...(spec.takesQuality ? { quality } : {}),
    });
  } catch (cause) {
    throw new EngineError(
      `无法编码为 ${spec.mime}：${(cause as Error).message}`,
      'encode-failed',
    );
  }
}
