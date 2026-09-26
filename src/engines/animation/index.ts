import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  MkvOutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
  type OutputFormat,
} from 'mediabunny';
import { Encoder, decodeFrames } from 'modern-gif';

import { getFormat } from '../../core/registry/formats.ts';
import { sniff } from '../../core/probe/sniff.ts';
import type { FormatId } from '../../core/types.ts';
import {
  EngineError,
  outputNameFor,
  type Engine,
  type EngineRequest,
  type EngineResult,
} from '../types.ts';

/**
 * The animation engine: the class transitions that involve a frame sequence.
 *
 * Both directions are projections — video becomes an animation, or an animation becomes
 * a video — and both are reported as such rather than dressed up as plain conversions.
 *
 * GIF timing works in centiseconds, so 10 ms is the finest interval it can express. We
 * preserve the source timing and let the loss model report the quantisation, rather than
 * quietly resampling to some "web friendly" rate the user never asked for.
 */

const GIF_CENTISECONDS_PER_SECOND = 100;
const GIF_MIN_DELAY = 1; // 10 ms
const GIF_MAX_COLORS = 255; // the encoder reserves one index for transparency

/**
 * A ceiling on how many frames we will hold.
 *
 * GIF encoding is inherently memory-hungry: the encoder accumulates one indexed byte per
 * pixel per frame, so thirty seconds of 1080p is hundreds of megabytes before any palette
 * work. Refusing clearly beats crashing the tab, and we say which limit was hit.
 */
const MAX_FRAMES = 1200;

const VIDEO_WRITERS: Partial<Record<FormatId, () => OutputFormat>> = {
  mp4: () => new Mp4OutputFormat(),
  mov: () => new MovOutputFormat(),
  mkv: () => new MkvOutputFormat(),
  webm: () => new WebMOutputFormat(),
};

/** Codec to encode a GIF's frames with, per target container. */
const VIDEO_CODECS: Partial<Record<FormatId, string>> = {
  mp4: 'avc',
  mov: 'avc',
  mkv: 'avc',
  webm: 'vp9',
};

interface DecodedFrame {
  width: number;
  height: number;
  /** Delay in centiseconds, as stored in the GIF. */
  delay: number;
  data: Uint8ClampedArray;
}

export class AnimationEngine implements Engine {
  readonly id = 'animation';

  /**
   * Claims GIF output, and the video containers too.
   *
   * The video claim is deliberately broad: the dispatcher tries Mediabunny first, and a
   * GIF source makes it fail with `unsupported`, which is the signal to fall through to
   * here. Narrowing this would mean having to know the source format at dispatch time,
   * which would cost a second probe.
   */
  supports(target: FormatId): boolean {
    return target === 'gif' || target in VIDEO_WRITERS;
  }

  async run(request: EngineRequest): Promise<EngineResult> {
    const { target, signal } = request;

    const spec = getFormat(target);
    const output =
      target === 'gif' ? await this.#toGif(request) : await this.#toVideo(request, target, signal);

    return {
      output,
      outputName: outputNameFor(request.inputName, spec.extension),
      engineId: this.id,
      did: 'transcode',
    };
  }

  /** Video → GIF, or animated GIF → GIF (a re-encode). */
  async #toGif(request: EngineRequest): Promise<Blob> {
    const { input, params, onProgress, signal } = request;

    const maxColors = clampMaxColors(params.paletteSize ?? GIF_MAX_COLORS);
    const dither = gifDither(params.dither);

    if (await isGif(input)) {
      const frames = await animatedFrames(input);
      return encodeFrames(frames, maxColors, dither, onProgress, signal);
    }

    return videoToGif(input, maxColors, dither, onProgress, signal);
  }

  /** Animated GIF → video container. */
  async #toVideo(request: EngineRequest, target: FormatId, signal?: AbortSignal): Promise<Blob> {
    if (!(await isGif(request.input))) {
      // Anything else that reaches here is a real format the other engines could not
      // read, and we will not invent motion for a still image.
      throw new EngineError('这个来源无法转成视频', 'unsupported');
    }

    const frames = await animatedFrames(request.input);
    if (signal?.aborted) throw new EngineError('已取消', 'aborted');
    if (frames.length > MAX_FRAMES) throw tooManyFrames(frames.length);

    const makeFormat = VIDEO_WRITERS[target];
    const codec = VIDEO_CODECS[target];
    if (!makeFormat || !codec) {
      throw new EngineError(`没有可以输出 ${target} 的动画引擎`, 'unsupported');
    }

    return framesToVideo(frames, makeFormat, codec, request.params);
  }
}

/* ------------------------------------------------------------------ video → GIF */

async function videoToGif(
  blob: Blob,
  maxColors: number,
  dither: DitherName,
  onProgress: EngineRequest['onProgress'],
  signal?: AbortSignal,
): Promise<Blob> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });

  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new EngineError('这个文件里没有视频轨道', 'unsupported');
  if (!(await track.canDecode())) {
    throw new EngineError('这个浏览器无法解码该视频轨道', 'decode-failed');
  }

  const sink = new CanvasSink(track);

  // The first frame settles dimensions, which the encoder needs before it can start.
  const first = await sink.getCanvas(0);
  if (!first) throw new EngineError('视频里没有可用的帧', 'decode-failed');

  const canvas0 = first.canvas;
  const encoder = new Encoder({
    width: canvas0.width,
    height: canvas0.height,
    maxColors,
    ...(dither ? { dither } : {}),
  });

  let count = 0;

  // One scratch canvas, reused for every frame.
  //
  // The encoder is handed raw pixels rather than the source canvas on purpose: given a
  // canvas it reaches for `document.createElement('canvas')` — which does not exist in
  // a worker — so its CanvasImageSource path is main-thread only.
  const scratch = new OffscreenCanvas(canvas0.width, canvas0.height);
  const scratchCtx = scratch.getContext('2d');
  if (!scratchCtx) throw new EngineError('无法创建绘图上下文', 'encode-failed');

  // Frames go to the encoder one at a time rather than being collected first: holding a
  // few hundred RGBA canvases would cost gigabytes, where the encoder's own indexed
  // representation is a quarter of that.
  const push = async (canvas: HTMLCanvasElement | OffscreenCanvas, durationSec: number) => {
    if (signal?.aborted) throw new EngineError('已取消', 'aborted');
    if (count >= MAX_FRAMES) throw tooManyFrames(count);

    scratchCtx.clearRect(0, 0, scratch.width, scratch.height);
    scratchCtx.drawImage(canvas, 0, 0);
    const pixels = scratchCtx.getImageData(0, 0, scratch.width, scratch.height).data;

    await encoder.encode({
      data: pixels,
      delay: Math.max(
        GIF_MIN_DELAY,
        Math.round(durationSec * GIF_CENTISECONDS_PER_SECOND),
      ),
    });
    count += 1;
    onProgress?.({ phase: 'encoding', ratio: undefined, frames: { done: count, total: 0 } });
  };

  await push(canvas0, first.duration);

  // `canvases(0)` restarts from the beginning, so skip the frame already taken.
  let skippedFirst = false;
  for await (const frame of sink.canvases(0)) {
    if (!skippedFirst) {
      skippedFirst = true;
      continue;
    }
    await push(frame.canvas, frame.duration);
  }

  return encoder.flush('blob');
}

/* ------------------------------------------------------------------ GIF → video */

async function framesToVideo(
  frames: readonly DecodedFrame[],
  makeFormat: () => OutputFormat,
  codec: string,
  params: Readonly<Record<string, unknown>>,
): Promise<Blob> {
  const first = frames[0];
  if (!first) throw new EngineError('这个动图里没有帧', 'decode-failed');

  const canvas = new OffscreenCanvas(first.width, first.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new EngineError('无法创建绘图上下文', 'encode-failed');

  // `quality` is not optional: Mediabunny requires either a quality or a bitrate and
  // throws `config.quality must be provided` without one.
  const source = new CanvasSource(canvas, {
    codec: codec as never,
    quality: new Quality(qualityPercent(params.quality)),
  });
  const target = new BufferTarget();
  const output = new Output({ format: makeFormat(), target });
  output.addVideoTrack(source);
  await output.start();

  let t = 0;
  for (const frame of frames) {
    ctx.putImageData(toImageData(frame), 0, 0);
    // A GIF delay of zero means "as fast as the renderer likes", which every
    // implementation treats as 10 ms.
    const duration = Math.max(GIF_MIN_DELAY, frame.delay) / GIF_CENTISECONDS_PER_SECOND;
    await source.add(t, duration);
    t += duration;
  }

  await output.finalize();

  const buffer = target.buffer;
  if (!buffer) throw new EngineError('没有产出任何数据', 'encode-failed');
  return new Blob([buffer]);
}

/* ---------------------------------------------------------------------- shared */

/** Decode any GIF into its frames. The engine already runs in a worker, so the decoder's
 * synchronous path is fine — there is no main thread here to block. */
async function animatedFrames(blob: Blob): Promise<DecodedFrame[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    return decodeFrames(bytes);
  } catch (cause) {
    throw new EngineError(`无法解码这个动图：${(cause as Error).message}`, 'decode-failed');
  }
}

/** Re-encode an existing frame sequence into a GIF, applying new palette settings. */
async function encodeFrames(
  frames: readonly DecodedFrame[],
  maxColors: number,
  dither: DitherName,
  onProgress: EngineRequest['onProgress'],
  signal?: AbortSignal,
): Promise<Blob> {
  const first = frames[0];
  if (!first) throw new EngineError('这个动图里没有帧', 'decode-failed');
  if (frames.length > MAX_FRAMES) throw tooManyFrames(frames.length);

  const encoder = new Encoder({
    width: first.width,
    height: first.height,
    maxColors,
    ...(dither ? { dither } : {}),
  });

  let done = 0;
  for (const frame of frames) {
    if (signal?.aborted) throw new EngineError('已取消', 'aborted');

    // Raw pixels straight through. Going via a canvas would send the encoder down its
    // `document.createElement('canvas')` path, which does not exist in a worker.
    await encoder.encode({
      data: asPixels(frame.data),
      delay: Math.max(GIF_MIN_DELAY, frame.delay),
    });
    done += 1;
    onProgress?.({ phase: 'encoding', ratio: done / frames.length, frames: { done, total: frames.length } });
  }

  return encoder.flush('blob');
}

/**
 * Wrap a decoded frame's raw RGBA in an ImageData.
 *
 * The cast is load-bearing: the decoder types its buffers as `ArrayBufferLike` (which
 * includes `SharedArrayBuffer`) while `ImageData` insists on a plain `ArrayBuffer`. At
 * runtime these are always ordinary buffers, and copying every frame just to satisfy the
 * type would double the peak memory of an already memory-hungry operation.
 */
function toImageData(frame: DecodedFrame): ImageData {
  return new ImageData(asPixels(frame.data), frame.width, frame.height);
}

/**
 * Narrow a decoded frame's buffer to what the encoder's types accept.
 *
 * The decoder types its buffers as `ArrayBufferLike` — which admits `SharedArrayBuffer` —
 * while the consumers insist on a plain `ArrayBuffer`. At runtime these are always
 * ordinary buffers, and copying every frame purely to satisfy the type would double peak
 * memory on an operation that is already the most memory-hungry thing here.
 */
function asPixels(data: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  return data as Uint8ClampedArray<ArrayBuffer>;
}

async function isGif(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  return sniff(head).container === 'gif';
}

/**
 * Our parameters are 0–100; Mediabunny's `Quality` takes the same scale as a number.
 *
 * The default is deliberately high: this path re-encodes an animation that has already
 * been through one lossy pass, and stacking a second aggressive compression on top of it
 * is how GIF → video ends up looking worse than the GIF.
 */
function qualityPercent(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 85;
  return Math.min(100, Math.max(0, value));
}

function tooManyFrames(count: number): EngineError {
  return new EngineError(
    `这段内容有 ${count} 帧，超过 ${MAX_FRAMES} 帧的上限。GIF 编码需要在内存里保留每一帧，` +
      `继续下去会把页面拖垮。请先把它裁短一些，或改用视频格式。`,
    'out-of-memory',
  );
}

type DitherName = 'floyd-steinberg' | 'atkinson' | 'stucki' | undefined;

function clampMaxColors(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return GIF_MAX_COLORS;
  return Math.min(GIF_MAX_COLORS, Math.max(2, Math.round(value)));
}

/**
 * Map our three user-facing dither choices onto the encoder's named methods.
 *
 * `ordered` maps to Atkinson rather than to a true ordered dither because the encoder
 * offers only error-diffusion variants; it is the fastest of the three, which is what
 * someone picking "ordered (fast)" is asking for.
 */
function gifDither(value: unknown): DitherName {
  if (value === 'none') return undefined;
  if (value === 'ordered') return 'atkinson';
  return 'floyd-steinberg';
}
