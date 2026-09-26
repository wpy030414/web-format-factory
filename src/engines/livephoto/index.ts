import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';

import { AnimationEngine } from '../animation/index.ts';
import { FfmpegEngine, tagAppleIdentifier } from '../ffmpeg/index.ts';
import { ImageEngine } from '../image/index.ts';
import { MediabunnyEngine } from '../mediabunny/index.ts';
import { getFormat } from '../../core/registry/formats.ts';
import { sniff } from '../../core/probe/sniff.ts';
import type { FormatId } from '../../core/types.ts';
import { detectMotionPhoto, unpackLivp, type LivePhotoInfo } from '../../livephoto/detect.ts';
import { buildLivp } from '../../livephoto/pack.ts';
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
    // Building one is claimed explicitly — none of the delegates produces a bundle, so
    // without this the engine would never be asked and the route would silently fail.
    if (target === 'live-photo') return true;

    return (
      this.image.supports(target) ||
      this.mediabunny.supports(target) ||
      this.animation.supports(target)
    );
  }

  async run(request: EngineRequest): Promise<EngineResult> {
    // Assembling a Live Photo is a different job from splitting one, and it is the only
    // route in the project that genuinely needs the fallback engine.
    if (request.target === 'live-photo') return this.#build(request);

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

  /**
   * Build an Apple Live Photo from a video.
   *
   * The still half is taken from the video's first frame, which is a real compromise —
   * Apple pairs a full-resolution photograph with the video, and a frame from 1080p
   * footage is not that. It is reported rather than hidden.
   *
   * The video must end up in a MOV, because that is what Apple's pairing expects, and
   * the MOV must carry the identifier that ties it to the still. That tagging is the one
   * job in this project ffmpeg is genuinely required for — see docs/DECISIONS.md ADR-004.
   */
  async #build(request: EngineRequest): Promise<EngineResult> {
    const { input, signal, onProgress } = request;

    if (!FfmpegEngine.available()) {
      throw new EngineError(
        '组装 Live Photo 需要写入 Apple 的配对标识，而兜底引擎在当前页面不可用' +
          '（通常是缺少 COOP/COEP 响应头）。',
        'engine-unavailable',
      );
    }

    const source = new Input({ source: new BlobSource(input), formats: ALL_FORMATS });
    const track = await source.getPrimaryVideoTrack();
    if (!track) throw new EngineError('这个文件里没有视频轨道', 'unsupported');
    if (!(await track.canDecode())) {
      throw new EngineError('这个浏览器无法解码该视频轨道', 'decode-failed');
    }

    // 1. A still from the first frame.
    onProgress?.({ phase: 'decoding', ratio: undefined, label: '截取静帧' });
    const sink = new CanvasSink(track);
    const first = await sink.getCanvas(0);
    if (!first) throw new EngineError('视频里没有可用的帧', 'decode-failed');

    const still = await canvasToJpeg(first.canvas);

    // 2. A MOV to pair it with. An MP4 or WebM has to be changed to MOV first; that
    //    step is a container change wherever the codec allows it.
    onProgress?.({ phase: 'muxing', ratio: undefined, label: '准备 MOV' });
    const movBytes = await this.#toMov(input, request, signal);

    // 3. The pairing identifier. Both halves must carry the same one or they are not a
    //    pair at all.
    const uuid = crypto.randomUUID().toUpperCase();
    onProgress?.({ phase: 'finalizing', ratio: undefined, label: '写入配对标识' });
    const tagged = await tagAppleIdentifier(movBytes, uuid);

    // 4. Package. `.livp` is a ZIP of the two, and it is what Apple's own tooling
    //    recognises when it arrives by AirDrop or from a file.
    const { bytes } = buildLivp(still, tagged);

    return {
      output: new Blob([bytes as BlobPart], { type: 'application/zip' }),
      outputName: outputNameFor(request.inputName, 'livp'),
      engineId: this.id,
      did: 'transcode',
      extraLosses: [
        {
          code: 'frame-selected',
          severity: 'info',
          detail: '静帧取自视频的第一帧，而不是一张全分辨率的照片。',
        },
        {
          code: 'still-image-time-track-missing',
          severity: 'info',
          detail: '缺少 still-image-time 轨道，导入时静帧可能不与视频首帧对齐。',
        },
      ],
    };
  }

  /** Produce a MOV, remuxing or transcoding from whatever the source actually is. */
  async #toMov(input: Blob, request: EngineRequest, signal?: AbortSignal): Promise<Uint8Array> {
    const head = new Uint8Array(await input.slice(0, 64).arrayBuffer());
    if (sniff(head).container === 'isobmff-mov') {
      // Already a MOV: nothing to do, and re-encoding it would be a pointless loss.
      return new Uint8Array(await input.arrayBuffer());
    }

    const result = await this.mediabunny.run({
      ...request,
      input,
      target: 'mov',
      ...(signal ? { signal } : {}),
    });
    return new Uint8Array(await result.output.arrayBuffer());
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
 * Encode a canvas as a JPEG.
 *
 * Quality is set high on purpose: this still is the half a viewer sees first and holds
 * on to, so it is the wrong place to save bytes.
 */
async function canvasToJpeg(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Uint8Array> {
  // Always draw through a canvas we own. A canvas handed to us by the frame sink may
  // already hold a context of another kind, and asking it for a 2d context would throw.
  // The extra copy costs one frame's worth of pixels, once.
  const out = new OffscreenCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  if (!ctx) throw new EngineError('无法创建绘图上下文', 'encode-failed');
  ctx.drawImage(canvas, 0, 0);

  // Quality is high on purpose: this still is the half a viewer looks at, so it is the
  // wrong place to save bytes.
  const blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return new Uint8Array(await blob.arrayBuffer());
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
