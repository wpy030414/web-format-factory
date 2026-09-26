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
  qualityFraction,
  type Engine,
  type EngineRequest,
  type EngineResult,
} from '../types.ts';
import {
  clampDelay,
  decideRegime,
  DEFAULT_FRAME_DELAY_MS,
  delaySecondsForVideo,
  GIF_DELAY_GRID_MS,
  GIF_MIN_DELAY_MS,
  planGrid,
  snapToGrid,
  stepCumulative,
} from './timing.ts';

/**
 * The animation engine: the class transitions that involve a frame sequence.
 *
 * Both directions are projections — video becomes an animation, or an animation becomes
 * a video — and both are reported as such rather than dressed up as plain conversions.
 *
 * Frame timing is where this engine can lie without meaning to. A GIF delay is a 16-bit
 * count of centiseconds, so 10 ms is the finest interval the format can express; renderers
 * clamp anything under 20 ms up to 100 ms, so 50 fps is the fastest a GIF can honestly
 * play; and the encoder floors whatever it is handed, so a delay that is not a whole
 * number of 10 ms steps is rounded *down* in silence. The rules that follow from those
 * three facts, and the measurements behind them, live in `./timing.ts`.
 *
 * What follows here: the source's timing is preserved, and what cannot be preserved is
 * reported. Conforming a source faster than 50 fps to what the format can hold is a loss,
 * not an edit — nobody chose a frame rate — and the loss model says so rather than leaving
 * the user to notice that their sixty frames a second came out slower.
 */

const GIF_MAX_COLORS = 255; // the encoder reserves one index for transparency

/**
 * A ceiling on how many frames we will hold.
 *
 * GIF encoding is inherently memory-hungry: the encoder accumulates one indexed byte per
 * pixel per frame, so thirty seconds of 1080p is hundreds of megabytes before any palette
 * work. Rather than refusing large jobs, the engine splits the timeline into independently
 * encoded segments — each stays within a safe memory ceiling, and the segments are delivered
 * as multiple files.
 */
const MAX_FRAMES = 1200;

/**
 * Maximum pixel-seconds per GIF segment.
 *
 * pixel-seconds = width × height × frame_count. A segment is a self-contained GIF whose
 * encoder holds at most this many bytes internally. When the source exceeds the budget the
 * engine produces multiple segments that each fit comfortably in the worker's heap.
 *
 * 400M px·s ≈ 1080p@193 frames ≈ 720p@434 frames ≈ 4K@48 frames.
 */
const MAX_GIF_PIXEL_SECONDS = 400_000_000;

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
  /** Delay in milliseconds — the unit the encoder takes, and the one the grid is in. */
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

    if (target === 'gif') {
      const blobs = await this.#toGif(request);
      return {
        outputs: blobs.map((blob, i) => ({
          blob,
          name: outputNameFor(request.inputName, spec.extension,
            blobs.length > 1 ? i : undefined),
        })),
        engineId: this.id,
        did: 'transcode',
      };
    }

    const output = await this.#toVideo(request, target, signal);
    return {
      outputs: [{ blob: output, name: outputNameFor(request.inputName, spec.extension) }],
      engineId: this.id,
      did: 'transcode',
    };
  }

  /** Video → GIF, or animated GIF → GIF (a re-encode). */
  async #toGif(request: EngineRequest): Promise<Blob[]> {
    const { input, params, onProgress, signal } = request;

    const maxColors = clampMaxColors(params.paletteSize ?? GIF_MAX_COLORS);
    const dither = gifDither(params.dither);

    // A GIF decodes through the GIF library; an animated WebP or APNG through the
    // browser's frame-level image API. Both give the same thing — a frame sequence —
    // and only the source differs.
    const frames =
      (await isGif(input))
        ? await animatedFrames(input)
        : await decodeImageAnimation(input);

    if (frames) return [await encodeFrames(frames, maxColors, dither, onProgress, signal)];

    return videoToGif(input, maxColors, dither, onProgress, signal);
  }

  /** Animated GIF, WebP or APNG → video container. */
  async #toVideo(request: EngineRequest, target: FormatId, signal?: AbortSignal): Promise<Blob> {
    const frames = (await isGif(request.input))
      ? await animatedFrames(request.input)
      : await decodeImageAnimation(request.input);

    if (!frames) {
      // Anything else that reaches here is a real format the other engines could not
      // read, and we will not invent motion for a still image.
      throw new EngineError('这个来源无法转成视频', 'unsupported');
    }

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
): Promise<Blob[]> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new EngineError('这个文件里没有视频轨道', 'unsupported');
    if (!(await track.canDecode())) {
      throw new EngineError('这个浏览器无法解码该视频轨道', 'decode-failed');
    }

    // Where this track's own timeline starts — not zero. A file whose first frame arrives
    // late would otherwise carry that lateness on its first frame, and `canvases(0)` yields
    // nothing at all for such a file, which is how it used to fail with "no usable frames".
    const originMs = Math.max(0, (await track.getFirstTimestamp()) * 1000);
    const durationMs = await track
      .computeDuration()
      .then((seconds) => seconds * 1000)
      .catch(() => Number.NaN);

    // How this source is laid onto a GIF's timeline, decided from the track's real packet
    // timestamps rather than from whatever the container claims. Both branches below are
    // decided here, before a single frame is decoded.
    const regime = decideRegime(
      await track.computeFrameRateMetrics().then(
        (metrics) => ({
          average: metrics.averageFrameRate,
          max: metrics.maxFrameRate,
          constant: metrics.frameRateIsConstant,
        }),
        // The probe for the loss report asks the same question, and the two are deliberately
        // independent: this one decides what gets written, that one decides what the user is
        // told, and neither is entitled to the other's answer.
        () => undefined,
      ),
    );

    const sink = new CanvasSink(track);

    let encoder: Encoder | undefined;
    let scratch: { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | undefined;
    let count = 0;
    const blobs: Blob[] = [];

    // When a segment fills up, flush the current encoder into a blob and start fresh.
    // This is how long videos stay within a safe memory ceiling: each segment produces
    // an independent GIF, and they are delivered as multiple files.
    //
    // How many raw pixel bytes the source adds per frame, read once from the track.
    const pixelCost = await computePixelCost(track);
    let pixelUsed = 0;

    // Frames go to the encoder one at a time rather than being collected first: holding a
    // canvas it reaches for `document.createElement('canvas')` — which does not exist in a
    // worker — so its CanvasImageSource path is main-thread only. Both the encoder and the
    // scratch canvas wait for the first frame that is actually kept, because that frame is
    // what sizes them.
    const push = async (canvas: HTMLCanvasElement | OffscreenCanvas, delayMs: number) => {
      if (signal?.aborted) throw new EngineError('已取消', 'aborted');
      if (count >= MAX_FRAMES) throw tooManyFrames(count);

      // Segment boundary: when the pixel budget runs out, flush this encoder and start a
      // new one. The fresh encoder and scratch canvas are created via `??=` on next call.
      if (encoder && pixelCost > 0 && pixelUsed + pixelCost > MAX_GIF_PIXEL_SECONDS) {
        blobs.push(await encoder.flush('blob'));
        encoder = undefined;
        scratch = undefined;
        count = 0;
        pixelUsed = 0;
      }

      encoder ??= new Encoder({
        width: canvas.width,
        height: canvas.height,
        maxColors,
        ...(dither ? { dither } : {}),
      });
      scratch ??= scratchCanvas(canvas.width, canvas.height);
      const { canvas: target, ctx } = scratch;

      ctx.clearRect(0, 0, target.width, target.height);
      ctx.drawImage(canvas, 0, 0);
      const pixels = ctx.getImageData(0, 0, target.width, target.height).data;

      await encoder.encode({ data: pixels, delay: clampDelay(delayMs) });
      count += 1;
      pixelUsed += pixelCost;
      onProgress?.({ phase: 'encoding', ratio: undefined, frames: { done: count, total: 0 } });
    };

    if (regime === 'grid' && Number.isFinite(durationMs) && durationMs > originMs) {
      await pushGrid(sink, planGrid(originMs, durationMs), push);
    } else {
      await pushCumulative(sink, originMs, durationMs, push);
    }

    if (!encoder) throw new EngineError('视频里没有可用的帧', 'decode-failed');
    // Flush the last (or only) segment.
    blobs.push(await encoder.flush('blob'));
    return blobs;
  } finally {
    // Input.dispose() cascades: it closes the demuxer, source refs, and all decoders
    // that the CanvasSink created. Without this, each video→GIF conversion leaks handles
    // that survive until the next GC pass — and a batch of ten conversions can exhaust
    // the heap before GC ever runs.
    input.dispose();
  }
}

/** Whichever frame we hand the encoder next: the grid regime, or the cumulative one. */
type PushFrame = (canvas: HTMLCanvasElement | OffscreenCanvas, delayMs: number) => Promise<void>;

/**
 * A source faster than the format can hold: sample it onto the grid of 20 ms slots.
 *
 * Every slot gets one frame, so the output plays at the fastest rate a GIF can honestly
 * play and lasts exactly as long as the source did. The frames in between are dropped —
 * which the loss model reports, because a user who filmed at 60 fps is entitled to know
 * that a fifth of their frames are not in the file.
 */
async function pushGrid(sink: CanvasSink, plan: ReturnType<typeof planGrid>, push: PushFrame) {
  // The output frame count is known before anything is decoded, so a source that cannot
  // fit is refused up front instead of halfway through.
  if (plan.stampsMs.length > MAX_FRAMES) throw tooManyFrames(plan.stampsMs.length);

  let pendingMs = 0;
  let index = 0;
  for await (const frame of sink.canvasesAtTimestamps(plan.stampsMs.map((ms) => ms / 1000))) {
    const delayMs = plan.delaysMs[index] ?? GIF_MIN_DELAY_MS;
    index += 1;

    // A slot that resolves to no frame hands its time to the next one that does, so the
    // timeline stays where the source put it rather than losing a slot's worth of it.
    if (!frame) {
      pendingMs += delayMs;
      continue;
    }

    await push(frame.canvas, pendingMs + delayMs);
    pendingMs = 0;
  }
}

/**
 * A source the format can hold: one frame at a time, each closed by its successor.
 *
 * The lookahead is load-bearing. A frame's end time comes from the *next* frame's start,
 * because `VideoFrame.duration` is frequently null and a NaN reaching the encoder's
 * `floor(delay / 10)` writes a zero delay — the very defect this path exists to avoid.
 *
 * Holding a frame's canvas across one iteration is safe because `CanvasSink` is given no
 * `poolSize`: every frame comes back in a canvas of its own. Give it a pool and this would
 * have to copy instead.
 */
async function pushCumulative(
  sink: CanvasSink,
  originMs: number,
  durationMs: number,
  push: PushFrame,
) {
  let held: { canvas: HTMLCanvasElement | OffscreenCanvas; startMs: number } | undefined;
  let cursorMs = snapToGrid(originMs);
  let lastIntervalMs = DEFAULT_FRAME_DELAY_MS;

  for await (const frame of sink.canvases(originMs / 1000)) {
    const startMs = frame.timestamp * 1000;

    if (held) {
      lastIntervalMs = Math.max(
        GIF_DELAY_GRID_MS,
        snapToGrid(startMs) - snapToGrid(held.startMs),
      );
      const step = stepCumulative(startMs, cursorMs);
      if (step.delayMs !== null) {
        cursorMs = step.cursorMs;
        await push(held.canvas, step.delayMs);
      }
    }

    held = { canvas: frame.canvas, startMs };
  }

  if (held) {
    // The last frame has no successor to close it: the track's own duration ends it, and
    // failing that, the interval it was running at.
    const endMs =
      Number.isFinite(durationMs) && durationMs > held.startMs
        ? durationMs
        : held.startMs + lastIntervalMs;
    const step = stepCumulative(endMs, cursorMs);
    await push(held.canvas, step.delayMs ?? GIF_MIN_DELAY_MS);
  }
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
    quality: new Quality(qualityFraction(params.quality, 0.85)),
  });
  const target = new BufferTarget();
  const output = new Output({ format: makeFormat(), target });
  output.addVideoTrack(source);
  await output.start();

  let t = 0;
  for (const frame of frames) {
    ctx.putImageData(toImageData(frame), 0, 0);
    // The target is a video container, not a GIF: its timestamps are exact, so the 20 ms
    // floor GIF's renderers impose does not apply here — only the grid the delay was
    // stored in, and a guard against a frame that carried no usable timing at all.
    const duration = delaySecondsForVideo(frame.delay);
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

/**
 * The slice of WebCodecs' image API this file uses.
 *
 * Declared locally rather than taken from the global typings, because `ImageDecoder` is
 * still unevenly available — present in Chromium and Firefox, absent from Safari — and
 * whether a given lib file admits that is not something worth depending on.
 */
interface ImageTrackListLike {
  /**
   * Resolves once the list has actually been populated.
   *
   * Not optional decoration. `completed` means the *bytes* have arrived; the track list
   * is filled in separately and lags behind it. Measured in Chromium: right after
   * `await decoder.completed`, `tracks.length` is 0 and `selectedTrack` is null — which
   * is indistinguishable from "this file is not an animation" and would send the job
   * down a path that cannot work.
   */
  ready?: Promise<void>;
  selectedTrack: { frameCount: number } | null;
}

interface ImageDecoderLike {
  tracks: ImageTrackListLike;
  completed: Promise<void>;
  decode(options: { frameIndex: number }): Promise<{ image: VideoFrame }>;
  close(): void;
}

interface ImageDecoderCtor {
  new (init: { data: BufferSource; type: string }): ImageDecoderLike;
}

/**
 * Decode an animated WebP or APNG into frames.
 *
 * Neither is a video, so the media library cannot read either one — and before this, the
 * only route from an animated WebP to a GIF ran through the 31 MB fallback engine, which
 * is an absurd price for something the browser can already do. `ImageDecoder` is
 * WebCodecs' frame-level image API, and it hands the animation over *composited*, so
 * frame disposal and blending are somebody else's problem.
 *
 * Returns `null` when this is not an animation we can take apart, leaving the caller to
 * decide whether some other path applies.
 */
async function decodeImageAnimation(blob: Blob): Promise<DecodedFrame[] | null> {
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const container = sniff(head).container;
  if (container !== 'webp' && container !== 'png') return null;

  const Decoder = (globalThis as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder;
  if (typeof Decoder !== 'function') return null;

  let decoder: ImageDecoderLike;
  try {
    decoder = new Decoder({
      data: await blob.arrayBuffer(),
      // The declared type decides how the bytes are read. A dropped file frequently has
      // no type at all, so it comes from the sniffed container instead of the Blob.
      type: container === 'webp' ? 'image/webp' : 'image/png',
    });
    await decoder.completed;
  } catch {
    // Either not an animation or not one this browser can parse. Not our business
    // either way — the caller has other paths to try.
    return null;
  }

  try {
    // Wait for the track list, not just for the bytes. See `ImageTrackListLike.ready`.
    await decoder.tracks.ready?.catch(() => undefined);

    const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
    // One frame is a still image, and the still-image engine handles those better.
    if (count < 2) return null;
    if (count > MAX_FRAMES) throw tooManyFrames(count);

    const frames: DecodedFrame[] = [];

    // One scratch canvas, sized from the first frame and reused for every one after it.
    // `??=` narrows it non-null for the rest of the loop body.
    let scratch: { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | undefined;

    for (let index = 0; index < count; index += 1) {
      const { image } = await decoder.decode({ frameIndex: index });
      try {
        scratch ??= scratchCanvas(image.displayWidth, image.displayHeight);
        const { canvas, ctx } = scratch;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0);

        frames.push({
          width: canvas.width,
          height: canvas.height,
          delay: delayMilliseconds(image.duration),
          // A fresh buffer per frame by necessity: the canvas is reused, so the pixels
          // have to be copied out before the next frame is drawn over them.
          data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        });
      } finally {
        // A leaked VideoFrame is the classic way a WebCodecs app runs out of decoder
        // slots and then dies somewhere unrelated.
        image.close();
      }
    }

    return frames;
  } finally {
    decoder.close();
  }
}

function scratchCanvas(width: number, height: number) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new EngineError('无法创建绘图上下文', 'encode-failed');
  return { canvas, ctx };
}

/**
 * WebCodecs reports frame durations in microseconds; the delay grid is in milliseconds,
 * which is where GIF's famous 10 ms granularity comes from.
 *
 * The value is left unsnapped on purpose: snapping each interval on its own is what makes
 * a timeline drift, so the rounding belongs to whoever can see the accumulated total.
 */
function delayMilliseconds(durationUs: number | null | undefined): number {
  if (typeof durationUs !== 'number' || !Number.isFinite(durationUs) || durationUs <= 0) {
    // A missing duration means "as fast as the renderer likes", which every
    // implementation settles at 100 ms.
    return DEFAULT_FRAME_DELAY_MS;
  }
  return Math.max(GIF_DELAY_GRID_MS, durationUs / 1000);
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

  // Re-encoded onto the source's own timeline: each delay is measured from where the
  // output has got to, then snapped to the grid — not floored frame by frame, which is
  // how a 33 ms frame becomes 30 ms and a ten-second animation quietly loses a second.
  //
  // The frame count is left alone here. A file that already has timing keeps all of it;
  // conforming to the 20 ms floor is for sources whose timing we are choosing.
  let elapsedMs = 0;
  let writtenMs = 0;
  let done = 0;
  for (const frame of frames) {
    if (signal?.aborted) throw new EngineError('已取消', 'aborted');

    elapsedMs +=
      Number.isFinite(frame.delay) && frame.delay > 0 ? frame.delay : DEFAULT_FRAME_DELAY_MS;
    const delayMs = clampDelay(snapToGrid(elapsedMs) - writtenMs, GIF_DELAY_GRID_MS);
    writtenMs += delayMs;

    // Raw pixels straight through. Going via a canvas would send the encoder down its
    // `document.createElement('canvas')` path, which does not exist in a worker.
    await encoder.encode({ data: asPixels(frame.data), delay: delayMs });
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

async function computePixelCost(track: { getSquarePixelWidth?(): Promise<number>; getCodedWidth?(): Promise<number>; getSquarePixelHeight?(): Promise<number>; getCodedHeight?(): Promise<number> }): Promise<number> {
  const w = await track.getSquarePixelWidth?.().catch(() => undefined)
    ?? await track.getCodedWidth?.().catch(() => 0)
    ?? 0;
  const h = await track.getSquarePixelHeight?.().catch(() => undefined)
    ?? await track.getCodedHeight?.().catch(() => 0)
    ?? 0;
  return w * h;
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
function tooManyFrames(count: number): EngineError {
  return new EngineError(
    `要输出 ${count} 帧，超过 ${MAX_FRAMES} 帧的上限。GIF 编码需要在内存里保留每一帧，` +
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
