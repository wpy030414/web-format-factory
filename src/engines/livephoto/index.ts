import { AnimationEngine } from '../animation/index.ts';
import { ImageEngine } from '../image/index.ts';
import { MediabunnyEngine } from '../mediabunny/index.ts';
import { getFormat } from '../../core/registry/formats.ts';
import { sniff } from '../../core/probe/sniff.ts';
import type { FormatId } from '../../core/types.ts';
import { detectMotionPhoto, unpackLivp, type LivePhotoInfo } from '../../livephoto/detect.ts';
import { extractXmp, stripMotionPhotoXmp, writeXmp } from '../../livephoto/xmp.ts';
import {
  EngineError,
  outputNameFor,
  type Engine,
  type EngineRequest,
  type EngineResult,
} from '../types.ts';

/**
 * Live Photo handling: splitting one apart.
 *
 * A Live Photo is not a format so much as a bundle, so every conversion out of one is a
 * projection — the user necessarily loses the other half. That is reported by the loss
 * model, not hidden here.
 *
 * Re-assembling a Live Photo is a separate concern and needs the fallback engine for
 * Apple's MOV tagging; see docs/specs/live-photo.md.
 */
export class LivePhotoEngine implements Engine {
  readonly id = 'livephoto';

  private readonly image = new ImageEngine();
  private readonly mediabunny = new MediabunnyEngine();
  private readonly animation = new AnimationEngine();

  /**
   * Claims every output a Live Photo can be split into.
   *
   * Deliberately broad, and it runs first in the chain. Splitting has to happen before
   * any generic handling: exporting the still through the plain image path would work,
   * but would carry the Motion Photo XMP along — producing a "still image" that still
   * claims to contain a video, which is precisely the kind of quiet lie this project
   * exists to avoid.
   */
  supports(target: FormatId): boolean {
    return (
      this.image.supports(target) ||
      this.mediabunny.supports(target) ||
      this.animation.supports(target)
    );
  }

  async run(request: EngineRequest): Promise<EngineResult> {
    const info = await this.#detect(request.input);
    if (!info) {
      // Not a Live Photo — step aside so the ordinary engines get their turn.
      throw new EngineError('这不是一个 Live Photo', 'unsupported');
    }

    const target = request.target;
    const spec = getFormat(target);

    // Which half does this target need?
    const wantsStill = this.image.supports(target);
    const half = wantsStill ? info.still : info.video;

    if (!half.bytes.length) {
      throw new EngineError('这个 Live Photo 缺少需要的那一半', 'unsupported');
    }

    // Stripping the Motion Photo claims from an exported still is not cosmetic: leaving
    // them in produces a file that tells every reader it contains a video it no longer
    // has.
    const bytes = wantsStill ? stripFalseClaims(half.bytes, info) : half.bytes;
    const extracted = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });

    // Delegate by trying, not by asking.
    //
    // `supports()` cannot settle this: the animation engine claims the video containers
    // as a fallback for GIF sources, so asking it whether it handles MP4 returns yes and
    // then it refuses the job. The same fall-through rule as the dispatcher applies —
    // an engine that cannot read the extracted half steps aside for the next one.
    const candidates = wantsStill
      ? [this.image]
      : target === 'gif'
        ? [this.animation, this.mediabunny]
        : [this.mediabunny, this.animation];

    let unsupported: unknown;
    for (const candidate of candidates) {
      if (!candidate.supports(target)) continue;
      try {
        const result = await candidate.run({ ...request, input: extracted });
        return {
          ...result,
          outputName: outputNameFor(request.inputName, spec.extension),
          engineId: this.id,
          // Both halves are carried over byte-for-byte — the split only ever *selects*
          // one of them. Any re-encoding is the delegate's doing, and it reports that
          // in its own result.
          did: result.did,
        };
      } catch (cause) {
        if ((cause as { code?: string })?.code !== 'unsupported') throw cause;
        unsupported = cause;
      }
    }

    throw unsupported instanceof EngineError
      ? unsupported
      : new EngineError('无法把 Live Photo 的这一半转成目标格式', 'unsupported');
  }

  /** Cheap pre-check, then the real detection only if the file looks like a Live Photo. */
  async #detect(blob: Blob): Promise<LivePhotoInfo | null> {
    const headBytes = new Uint8Array(await blob.slice(0, 128 * 1024).arrayBuffer());
    const container = sniff(headBytes).container;

    if (container === 'zip') {
      return unpackLivp(new Uint8Array(await blob.arrayBuffer()));
    }

    if (container !== 'jpeg') return null;

    // The marker lives in the APP1 segment near the start, so the head settles it —
    // reading the whole file would be wasteful for the overwhelmingly common case of an
    // ordinary JPEG.
    const xmp = extractXmp(headBytes);
    if (!xmp || !/Camera:(MotionPhoto|MicroVideo)\s*=\s*"1"/.test(xmp)) return null;

    // Now the full read, because verification needs the trailing bytes.
    return detectMotionPhoto(new Uint8Array(await blob.arrayBuffer()), 'jpeg');
  }
}

/**
 * Remove the Motion Photo claims from a still that is being exported on its own.
 *
 * Returns the bytes unchanged when there is nothing to strip, so this never costs a
 * copy for a file that does not need one.
 */
function stripFalseClaims(still: Uint8Array, info: LivePhotoInfo): Uint8Array {
  if (info.flavor !== 'google-motionphoto-jpeg') return still;

  const xmp = extractXmp(still);
  if (!xmp) return still;

  try {
    const stripped = stripMotionPhotoXmp(xmp);
    // A completely empty packet would be worse than none — some readers treat a present
    // but blank XMP block as corruption.
    if (stripped.trim().length === 0) return still;
    return writeXmp(still, stripped);
  } catch {
    // If the rewrite fails, hand back the still as-is rather than failing the job: the
    // metadata is stale but the picture is intact and usable.
    return still;
  }
}
