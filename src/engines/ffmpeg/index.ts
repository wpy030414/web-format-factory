import { FFmpeg } from '@ffmpeg/ffmpeg';
import { FFFSType } from '@ffmpeg/ffmpeg';

import { getFormat } from '../../core/registry/formats.ts';
import type { FormatId } from '../../core/types.ts';
import {
  EngineError,
  outputNameFor,
  type Engine,
  type EngineRequest,
  type EngineResult,
} from '../types.ts';

/**
 * The fallback engine: ffmpeg.wasm.
 *
 * It is the last resort by design. The core is 32 MB and, being software x86 compiled to
 * wasm with `--disable-asm`, runs an order of magnitude slower than native — so every
 * route that can avoid it must. What it buys is reach: the handful of operations nothing
 * else can do.
 *
 * See `docs/specs/engine-routing.md` for the whitelist. Anything reaching here that is
 * not on it is a routing bug, not a feature.
 */

/** Where the staged core lives. Same-origin, so no blob-URL dance is needed. */
const ENGINE_BASE = '/engines/ffmpeg';

/** Paths inside the emscripten filesystem. One job at a time, so fixed names are fine. */
const INPUT_PATH = 'input';
const OUTPUT_PATH = 'output';

/** Where inputs are mounted. Must be created before mounting. */
const MOUNT_POINT = '/mnt';

/**
 * How long to wait for `load()` before giving up.
 *
 * ffmpeg.wasm fails *silently* when the page is not cross-origin isolated: the promise
 * simply never settles. A timeout converts that into something the user can be told.
 */
const LOAD_TIMEOUT_MS = 120_000;

interface FfmpegTarget {
  /** Arguments from the input path to the output path. */
  args: (source: string, sink: string, params: Readonly<Record<string, unknown>>) => string[];
}

/**
 * Operations this engine is permitted to perform.
 *
 * Deliberately tiny. Each entry is something no other engine can do, and adding one
 * should feel like a decision rather than a convenience.
 */
const TARGETS: Partial<Record<FormatId, FfmpegTarget>> = {
  // No maintained JS/WASM package exposes libwebp's animation encoder.
  'webp-anim': {
    args: (source, sink, params) => {
      const quality = percent(params.quality, 80);
      return [
        '-i', source,
        '-c:v', 'libwebp_anim',
        '-loop', '0',
        '-q:v', String(quality),
        '-an',
        sink,
      ];
    },
  },

  // APNG is the other animation container with no encoder in reach: `canvas.convertToBlob`
  // writes a single frame, and the libraries that do exist are unmaintained. The muxer
  // has to be named explicitly — `.png` on its own selects the still-image muxer, which
  // would silently write the first frame and call it an animation.
  apng: {
    args: (source, sink) => [
      '-i', source,
      '-c:v', 'apng',
      '-plays', '0',
      '-f', 'apng',
      sink,
    ],
  },

  // Vorbis, which the primary engine can decode and nothing can write — libvorbis lives
  // only in ffmpeg. Opus is the better codec and the default; this exists because
  // "Ogg + Vorbis" is what some players still ask for, and the parameter panel has been
  // promising this route since before it existed.
  ogg: {
    args: (source, sink, params) => [
      '-i', source,
      '-c:a', 'libvorbis',
      // libvorbis grades quality 0–10 where ours is 0–100.
      '-q:a', String(Math.round(percent(params.quality, 80) / 10)),
      // Whatever container the source was in, the target is audio.
      '-vn',
      sink,
    ],
  },
};

export class FfmpegEngine implements Engine {
  readonly id = 'ffmpeg';

  private static instance: FFmpeg | null = null;
  private static loading: Promise<FFmpeg> | null = null;
  /** The tail of ffmpeg's own output, attached to failures so they are diagnosable. */
  private static recentLog: string[] = [];

  supports(target: FormatId): boolean {
    return target in TARGETS;
  }

  /** Can this environment run the fallback engine at all? */
  static available(): boolean {
    return typeof self !== 'undefined' && self.crossOriginIsolated === true;
  }

  async run(request: EngineRequest): Promise<EngineResult> {
    const { input, target, params, signal } = request;

    const spec = TARGETS[target];
    if (!spec) throw new EngineError(`兜底引擎不支持输出 ${target}`, 'unsupported');

    if (!FfmpegEngine.available()) {
      throw new EngineError(
        '这个页面没有开启跨源隔离，兜底引擎无法运行。',
        'engine-unavailable',
      );
    }

    const ffmpeg = await FfmpegEngine.acquire(request);

    const inputName = `${INPUT_PATH}.${extensionOf(input)}`;
    const outputName = `${OUTPUT_PATH}.${getFormat(target).extension}`;

    try {
      // WORKERFS hands ffmpeg a read-only view of the Blob instead of copying it into
      // the wasm heap. The multithreaded core reserves a fixed 1 GB and cannot grow it,
      // so copying a large input in is how these conversions die.
      //
      // The mount point has to exist first — emscripten raises a bare `ErrnoError: FS
      // error` otherwise, which says nothing about the missing directory.
      await ffmpeg.createDir(MOUNT_POINT).catch(() => undefined);
      await ffmpeg.mount(FFFSType.WORKERFS, { files: [new File([input], inputName)] }, MOUNT_POINT);
      const source = `${MOUNT_POINT}/${inputName}`;

      FfmpegEngine.recentLog = [];
      const exit = await ffmpeg.exec(
        spec.args(source, outputName, params),
        undefined,
        signal ? { signal } : undefined,
      );
      if (exit !== 0) {
        throw new EngineError(
          `兜底引擎以非零状态退出（${exit}）${explain(FfmpegEngine.recentLog)}`,
          'encode-failed',
        );
      }

      const data = await ffmpeg.readFile(outputName);
      if (typeof data === 'string') {
        throw new EngineError('兜底引擎返回了文本而不是媒体数据', 'encode-failed');
      }

      return {
        outputs: [
          {
            blob: new Blob([data as BlobPart], { type: getFormat(target).mime }),
            name: outputNameFor(request.inputName, getFormat(target).extension),
          },
        ],
        engineId: this.id,
        did: 'transcode',
      };
    } finally {
      // Deterministic cleanup on every path. The wasm heap cannot grow, so a leaked
      // output file is a permanent loss of headroom for the rest of the session.
      await ffmpeg.deleteFile(outputName).catch(() => undefined);
      await ffmpeg.unmount(MOUNT_POINT).catch(() => undefined);
    }
  }

  /**
   * Get a loaded instance, sharing one across jobs.
   *
   * Loading is a 32 MB fetch plus instantiation — seconds on a good connection, tens of
   * seconds on a poor one. Doing it per job would be indefensible, so the instance is
   * kept alive and only rebuilt if it has been evicted.
   */
  static async acquire(request: EngineRequest): Promise<FFmpeg> {
    if (FfmpegEngine.instance) return FfmpegEngine.instance;
    if (FfmpegEngine.loading) return FfmpegEngine.loading;

    FfmpegEngine.loading = (async () => {
      const ffmpeg = new FFmpeg();

      ffmpeg.on('log', ({ message }) => {
        // Kept because ffmpeg reports the reason for a failure on stderr and exits with
        // a bare non-zero code. Without this tail, "the conversion failed" is all anyone
        // can ever say about it.
        FfmpegEngine.recentLog.push(message);
        if (FfmpegEngine.recentLog.length > 40) FfmpegEngine.recentLog.shift();
      });

      ffmpeg.on('progress', ({ progress }) => {
        // ffmpeg's own progress figure is unreliable for stream copies and meaningless
        // before the output duration is known, so it is reported as-is and the UI
        // decides whether to trust it.
        request.onProgress?.({
          phase: 'encoding',
          ratio: Number.isFinite(progress) && progress > 0 ? progress : undefined,
          label: '兜底引擎',
        });
      });

      request.onProgress?.({ phase: 'loading-engine', ratio: undefined, label: '兜底引擎（约 31 MB）' });

      const loaded = await withTimeout(
        ffmpeg.load({
          classWorkerURL: `${ENGINE_BASE}/worker.js`,
          coreURL: `${ENGINE_BASE}/ffmpeg-core.js`,
          wasmURL: `${ENGINE_BASE}/ffmpeg-core.wasm`,
          workerURL: `${ENGINE_BASE}/ffmpeg-core.worker.js`,
        }),
        LOAD_TIMEOUT_MS,
      );

      if (!loaded) throw new EngineError('兜底引擎加载失败', 'engine-unavailable');

      FfmpegEngine.instance = ffmpeg;
      FfmpegEngine.loading = null;
      return ffmpeg;
    })();

    try {
      return await FfmpegEngine.loading;
    } catch (cause) {
      // Do not cache a failure — the next attempt should be able to retry.
      FfmpegEngine.loading = null;
      throw cause instanceof EngineError
        ? cause
        : new EngineError(`兜底引擎加载失败：${(cause as Error).message}`, 'engine-unavailable');
    }
  }

  /** Drop the instance, freeing the gigabyte it reserves. */
  static evict(): void {
    FfmpegEngine.instance?.terminate();
    FfmpegEngine.instance = null;
    FfmpegEngine.loading = null;
  }
}

/**
 * Tag a QuickTime file with Apple's Live Photo pairing identifier.
 *
 * This is the one operation in the project that ffmpeg is genuinely required for: the
 * main engine's metadata writer accepts only four-character `ilst` atom names and drops
 * long `com.apple.*` keys without complaint. Verified by experiment — see
 * docs/DECISIONS.md ADR-004.
 *
 * `-movflags use_metadata_tags` is **not optional**: without it the tag is written as a
 * plain `udta` entry, ffprobe cannot read it back, and nothing reports an error.
 */
export async function tagAppleIdentifier(mov: Uint8Array, uuid: string): Promise<Uint8Array> {
  if (!FfmpegEngine.available()) {
    throw new EngineError('这个页面没有开启跨源隔离，无法写入 Apple 配对标识。', 'engine-unavailable');
  }

  const ffmpeg = await FfmpegEngine.acquire({
    input: new Blob(),
    inputName: 'tag',
    target: 'mov',
    params: {},
  });

  const source = 'tag-input.mov';
  const sink = 'tag-output.mov';

  try {
    await ffmpeg.writeFile(source, mov);
    const exit = await ffmpeg.exec([
      '-i', source,
      '-c', 'copy',
      '-movflags', 'use_metadata_tags',
      '-metadata', `com.apple.quicktime.content.identifier=${uuid}`,
      sink,
    ]);
    if (exit !== 0) throw new EngineError(`写入配对标识失败（退出码 ${exit}）`, 'encode-failed');

    const data = await ffmpeg.readFile(sink);
    if (typeof data === 'string') throw new EngineError('兜底引擎返回了文本', 'encode-failed');
    return data;
  } finally {
    await ffmpeg.deleteFile(source).catch(() => undefined);
    await ffmpeg.deleteFile(sink).catch(() => undefined);
  }
}

/** The most useful line or two of ffmpeg's own output, for the user-facing error. */
function explain(log: readonly string[]): string {
  // The last non-empty lines carry the actual complaint; the rest is banner noise.
  const meaningful = log.map((l) => l.trim()).filter(Boolean).slice(-3);
  return meaningful.length > 0 ? `：${meaningful.join(' / ')}` : '';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new EngineError(
              `兜底引擎在 ${ms / 1000} 秒内没有响应。缺少 COOP/COEP 响应头时它会静默挂起，` +
                `这是最常见的原因。`,
              'engine-unavailable',
            ),
          ),
        ms,
      ),
    ),
  ]);
}

function extensionOf(blob: Blob): string {
  const parts = blob.type.split('/');
  return parts[1]?.split(';')[0] ?? 'bin';
}

function percent(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(100, Math.max(0, Math.round(value)));
}
