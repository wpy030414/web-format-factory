import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';

import { AnimationEngine } from '../animation/index.ts';
import { FfmpegEngine, tagAppleIdentifier } from '../ffmpeg/index.ts';
import { ImageEngine } from '../image/index.ts';
import { MediabunnyEngine } from '../mediabunny/index.ts';
import { getFormat } from '../../core/registry/formats.ts';
import { severityOf, type LossItem } from '../../core/loss/codes.ts';
import { sniff } from '../../core/probe/sniff.ts';
import type { FormatId } from '../../core/types.ts';
import { detectMotionPhoto, unpackLivp, type LivePhotoInfo } from '../../livephoto/detect.ts';
import { buildMotionPhoto } from '../../livephoto/pack.ts';
import {
  readAppleMakerNoteIdentifier,
  relocateMovieMeta,
  writeAppleMakerNote,
} from '../../livephoto/apple.ts';
import { extractXmp, stripMotionPhotoXmp, writeXmp } from '../../livephoto/xmp.ts';
import {
  EngineError,
  outputNameFor,
  type Engine,
  type EngineRequest,
  type EngineResult,
} from '../types.ts';

/**
 * Containers holding a frame sequence and no track structure.
 *
 * The three animated formats this project accepts, named by container because that is
 * what the bytes say: the media library cannot read any of them, and each has to be
 * taken apart by the machinery that owns it.
 */
const ANIMATED_CONTAINERS: ReadonlySet<string> = new Set(['gif', 'webp', 'png']);

/**
 * Where a bare source's still frame comes from.
 *
 * A bundle brings a photograph with it; these two have to have one picked out of them,
 * and the two are picked out in entirely different ways.
 */
type FrameSource = 'video' | 'animation';

const FRAME_SELECTED_DETAIL: Record<FrameSource, string> = {
  video: '静帧取自视频的第一帧，而不是一张全分辨率的照片。',
  animation: '静帧取自动图的第一帧，而不是一张全分辨率的照片。',
};

/**
 * Live Photo handling: splitting one apart, and putting one together.
 *
 * A Live Photo is not a format so much as a bundle, so every conversion out of one is a
 * projection — the user necessarily loses the other half. That is reported by the loss
 * model, not hidden here.
 *
 * Assembling one takes a single input and derives both halves from it. Two kinds of
 * source can do that: a video, whose first frame stands in for the photograph, and an
 * animated image, whose first frame does the same and whose frames become the video.
 * Apple's flavour additionally needs the fallback engine for its MOV tagging; see
 * docs/specs/live-photo.md.
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
    // Both bundles are assembled here. None of the delegates produces one — the image
    // engine writes a still, the media engine a plain video — so without this the engine
    // would never be asked and the route would silently fail.
    if (target === 'live-photo' || target === 'motion-photo') return true;

    return (
      this.image.supports(target) ||
      this.mediabunny.supports(target) ||
      this.animation.supports(target)
    );
  }

  async run(request: EngineRequest): Promise<EngineResult> {
    // Assembling a bundle is a different job from taking one apart, and which flavour of
    // bundle it is decides almost everything about how it is done.
    if (request.target === 'live-photo') return this.#build(request);
    if (request.target === 'motion-photo') return this.#buildMotionPhoto(request);

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
          outputs: result.outputs.map((o) => ({
            blob: o.blob,
            name: outputNameFor(request.inputName, spec.extension),
          })),
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

    // An existing bundle brings both halves with it, and they beat anything re-derived:
    // a real full-resolution photograph, and a video that is already the right thing.
    // Anything else has to give up a frame as the still — a video just as much as an
    // animated image.
    const existing = await this.#detect(input);
    const losses: LossItem[] = [];

    onProgress?.({ phase: 'decoding', ratio: undefined, label: '准备静帧' });
    let still: Uint8Array;
    if (existing) {
      still = await this.#stillHalf(existing, request, losses);
    } else {
      const frame = await this.#frameSource(input);
      still = await this.#stillFromFrame(input, request, frame);
      losses.push({
        code: 'frame-selected',
        severity: severityOf('frame-selected'),
        detail: FRAME_SELECTED_DETAIL[frame],
      });
    }

    // 2. A MOV to pair it with. An MP4 or WebM has to be changed to MOV first; that
    //    step is a container change wherever the codec allows it.
    onProgress?.({ phase: 'muxing', ratio: undefined, label: '准备 MOV' });
    const movBytes = await this.#videoHalf(existing, input, request, 'mov', signal);

    // 3. The pairing identifier. Both halves must carry the same one, and they keep it in
    //    different places: the still in its maker notes, the movie in QuickTime metadata.
    //    Photos pairs them only when the two agree — which is why both sides are written
    //    here, and why the movie's metadata is moved to where Apple's reader looks
    //    (docs/researches/live-photo-photos-import.md). A still that arrived as part of a
    //    bundle already carries an identifier of its own; reusing it is more faithful than
    //    inventing a new one, and does not require rewriting that still's metadata.
    const existingIdentifier = readAppleMakerNoteIdentifier(still);
    const uuid = existingIdentifier ?? crypto.randomUUID().toUpperCase();
    onProgress?.({ phase: 'finalizing', ratio: undefined, label: '写入配对标识' });

    const taggedMovie = relocateMovieMeta(await tagAppleIdentifier(movBytes, uuid));

    let taggedStill = still;
    if (existingIdentifier === null) {
      try {
        taggedStill = writeAppleMakerNote(still, uuid);
      } catch {
        // The still carries EXIF already, and rewriting that EXIF to make room for a
        // maker note is a job this engine does not do. Reported rather than faked: the
        // pair is still written, but it will import as two items instead of one.
        losses.push({
          code: 'pairing-identifier-not-written',
          severity: severityOf('pairing-identifier-not-written'),
          detail: '静态图已带 EXIF，无法在不破坏它的前提下写入 Apple 的配对标识。',
        });
      }
    }

    const extraLosses: LossItem[] = [
      ...losses,
      {
        code: 'still-image-time-track-missing',
        severity: severityOf('still-image-time-track-missing'),
        // Measured rather than hedged: taking all three of Apple's metadata tracks out of
        // a working pair left it working, so its absence does not stop Photos from pairing
        // the halves. It remains a difference from Apple's own output, and is reported as
        // that. See docs/researches/live-photo-photos-import.md.
        detail:
          '没有写入 Apple 的 still-image-time 轨道：它用来标记静帧落在时间轴上的哪一点。' +
          '实测它不影响相册是否把两半认成一张实况照片，但仍与 Apple 自身的产物有差异。',
      },
    ];

    // 4. Hand both halves over loose — never as a `.livp`.
    //
    //    The `.livp` is one file, and it is also the one shape a photo library refuses to
    //    import: macOS has no type for it at all, and iOS treats it as an unknown
    //    document. Loose files are what actually goes in, and therefore what can be
    //    AirDropped from Photos to an iPhone afterwards. See
    //    docs/researches/live-photo-photos-import.md §7.1.
    const stillIsHeic = sniff(taggedStill.subarray(0, 64)).container === 'isobmff-heic';
    const stillName = outputNameFor(request.inputName, stillIsHeic ? 'heic' : 'jpg');
    return {
      outputs: [
        {
          blob: new Blob([taggedStill as BlobPart], {
            type: stillIsHeic ? 'image/heic' : 'image/jpeg',
          }),
          name: stillName,
        },
        {
          blob: new Blob([taggedMovie as BlobPart], { type: 'video/quicktime' }),
          name: outputNameFor(request.inputName, 'mov'),
        },
      ],
      engineId: this.id,
      did: 'transcode',
      extraLosses,
    };
  }

  /**
   * Build a Google Motion Photo: one JPEG with the video appended.
   *
   * The cheap flavour, and the one worth reaching for by default. Apple's needs ffmpeg to
   * write its pairing identifier, which means a 31 MB download and cross-origin isolation;
   * this one is pure byte work, so it needs neither. It is also the shape that survives
   * being handed to a phone that understands only a single file.
   */
  async #buildMotionPhoto(request: EngineRequest): Promise<EngineResult> {
    const { input, signal, onProgress } = request;

    // Where the two halves come from depends on what was dropped. An existing Live Photo
    // brings a full-resolution still of its own, and throwing that away to re-shoot it
    // from a frame would discard the best thing in the file; a bare video or animation
    // has nothing but its frames.
    const existing = await this.#detect(input);
    const losses: LossItem[] = [];

    let still: Uint8Array;
    if (existing) {
      still = await this.#stillHalf(existing, request, losses);
    } else {
      onProgress?.({ phase: 'decoding', ratio: undefined, label: '截取静帧' });
      const frame = await this.#frameSource(input);
      still = await this.#stillFromFrame(input, request, frame);
      losses.push({
        code: 'frame-selected',
        severity: severityOf('frame-selected'),
        detail: FRAME_SELECTED_DETAIL[frame],
      });
    }

    onProgress?.({ phase: 'muxing', ratio: undefined, label: '准备 MP4' });
    const video = await this.#videoHalf(existing, input, request, 'mp4', signal);

    onProgress?.({ phase: 'finalizing', ratio: undefined, label: '拼接并写入 XMP' });

    let bytes: Uint8Array;
    try {
      // The still sits at the very start of the appended video, so its presentation
      // timestamp is zero. That is a fact about what was just built, not a guess.
      ({ bytes } = buildMotionPhoto(still, video, { presentationTimestampUs: 0 }));
    } catch (cause) {
      throw new EngineError(
        `无法封装为 Motion Photo：${(cause as Error).message}`,
        'encode-failed',
      );
    }

    const spec = getFormat('motion-photo');
    return {
      outputs: [
        { blob: new Blob([bytes as BlobPart], { type: spec.mime }), name: outputNameFor(request.inputName, spec.extension) },
      ],
      engineId: this.id,
      did: 'transcode',
      ...(losses.length > 0 ? { extraLosses: losses } : {}),
    };
  }

  /**
   * The still half of an existing Live Photo, re-encoded only when it has to be.
   *
   * A JPEG is already exactly what the packaging wants, so it crosses over byte for byte
   * — re-encoding it would be a generation loss bought for nothing.
   */
  async #stillHalf(
    info: LivePhotoInfo,
    request: EngineRequest,
    losses: LossItem[],
  ): Promise<Uint8Array> {
    if (info.still.stillFormat !== 'heic') {
      // Carried across byte for byte, minus any claim that was only true in its old
      // home. A Google still says "I contain a video" in its own XMP; moved into an Apple
      // bundle, that video is a separate file and the claim becomes a lie — one the
      // exported still would tell every reader that opened it.
      return stripFalseClaims(info.still.bytes, info);
    }

    // A HEIC still does have to be decoded and re-encoded: the metadata this format needs
    // lives in a JPEG APP1 segment, and writing XMP into HEIC means rewriting its
    // `iinf`/`iloc`/`idat` boxes — a job this project does not do. See
    // docs/specs/live-photo.md.
    const result = await this.image.run({
      ...request,
      input: new Blob([info.still.bytes as BlobPart]),
      target: 'jpeg',
    });

    losses.push({
      code: 'requantized',
      severity: severityOf('requantized'),
      detail: '静图是 HEIC，而 Motion Photo 的元数据只能写进 JPEG，因此重新编码了一次。',
    });

    return new Uint8Array(await result.outputs[0]!.blob.arrayBuffer());
  }

  /**
   * The video half, in the container the target flavour requires.
   *
   * Apple pairs against a MOV and Google against an MP4, and neither will accept the
   * other. When the source's video is already in the right container it crosses over byte
   * for byte — a re-encode there would be a pointless generation loss.
   */
  async #videoHalf(
    info: LivePhotoInfo | null,
    input: Blob,
    request: EngineRequest,
    container: 'mov' | 'mp4',
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const source = info ? new Blob([info.video.bytes as BlobPart]) : input;

    const head = new Uint8Array(await source.slice(0, 64).arrayBuffer());
    const sniffed = sniff(head).container;
    const wanted = container === 'mov' ? 'isobmff-mov' : 'isobmff-mp4';
    if (sniffed === wanted) return new Uint8Array(await source.arrayBuffer());

    // An animated image has frames but no tracks, so the media library refuses it and the
    // animation engine is the only thing that can turn it into a real video. That
    // re-encode is the honest price of asking an animation to be a movie, and the loss
    // model already reports the conversion as one.
    if (ANIMATED_CONTAINERS.has(sniffed)) {
      const encoded = await this.animation.run({
        ...request,
        input: source,
        target: container,
        ...(signal ? { signal } : {}),
      });
      return new Uint8Array(await encoded.outputs[0]!.blob.arrayBuffer());
    }

    const result = await this.mediabunny.run({
      ...request,
      input: source,
      target: container,
      ...(signal ? { signal } : {}),
    });
    return new Uint8Array(await result.outputs[0]!.blob.arrayBuffer());
  }

  /**
   * Which kind of frame source a bare input offers.
   *
   * Decided by the container rather than by trying one reader and catching its failure.
   * A GIF handed to the media library fails from somewhere deep inside it, and an error
   * whose origin we cannot name is not one this project is willing to attribute.
   */
  async #frameSource(input: Blob): Promise<FrameSource> {
    const head = new Uint8Array(await input.slice(0, 64).arrayBuffer());
    return ANIMATED_CONTAINERS.has(sniff(head).container) ? 'animation' : 'video';
  }

  /** The still half for a source that is not already a bundle. */
  async #stillFromFrame(
    input: Blob,
    request: EngineRequest,
    source: FrameSource,
  ): Promise<Uint8Array> {
    if (source === 'video') return this.#stillFromVideo(input, request);

    // The first frame is what a viewer already sees before pressing anything, which makes
    // it the honest choice — and the image engine knows how to lift one out of every
    // animated format this project accepts.
    const result = await this.image.run({ ...request, input, target: 'jpeg' });
    return new Uint8Array(await result.outputs[0]!.blob.arrayBuffer());
  }

  /** A JPEG still taken from a video's first frame. */
  async #stillFromVideo(blob: Blob, request: EngineRequest): Promise<Uint8Array> {
    const source = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const track = await source.getPrimaryVideoTrack();
    if (!track) throw new EngineError('这个文件里没有视频轨道', 'unsupported');
    if (!(await track.canDecode())) {
      throw new EngineError('这个浏览器无法解码该视频轨道', 'decode-failed');
    }

    const sink = new CanvasSink(track);
    const first = await sink.getCanvas(0);
    if (!first) throw new EngineError('视频里没有可用的帧', 'decode-failed');

    return canvasToJpeg(first.canvas, stillQuality(request.params.quality));
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
 * Quality comes from the target format's own parameter rather than being fixed here: an
 * earlier revision hard-coded it, which meant the panel offered a 「静帧质量」 slider that
 * the code ignored. A control that does nothing is worse than no control.
 */
async function canvasToJpeg(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  quality: number,
): Promise<Uint8Array> {
  // Always draw through a canvas we own. A canvas handed to us by the frame sink may
  // already hold a context of another kind, and asking it for a 2d context would throw.
  // The extra copy costs one frame's worth of pixels, once.
  const out = new OffscreenCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  if (!ctx) throw new EngineError('无法创建绘图上下文', 'encode-failed');
  ctx.drawImage(canvas, 0, 0);

  const blob = await out.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Our parameters are 0–100; `convertToBlob` wants 0–1.
 *
 * The fallback is deliberately high: this still is the half a viewer looks at and holds
 * on to, so it is the wrong place to save bytes.
 */
function stillQuality(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.92;
  return Math.min(1, Math.max(0, value / 100));
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
