/// <reference lib="webworker" />
import { MediabunnyEngine } from '../engines/mediabunny/index.ts';
import { ImageEngine } from '../engines/image/index.ts';
import { AnimationEngine } from '../engines/animation/index.ts';
import { LivePhotoEngine } from '../engines/livephoto/index.ts';
import { FfmpegEngine } from '../engines/ffmpeg/index.ts';
import { EngineError, type Engine, type EngineRequest, type JobProgress } from '../engines/types.ts';
import { probe } from '../core/probe/probe.ts';
import type { MediaProfile } from '../core/probe/profile.ts';
import type { FormatId } from '../core/types.ts';
import type { LossItem } from '../core/loss/codes.ts';

/**
 * Worker-side message protocol.
 *
 * Kept explicit rather than passing callbacks across, so the boundary stays a plain
 * data channel and the worker can be reasoned about in isolation.
 *
 * Probing lives here too, not because parsing is slow but because it needs the same
 * media library as conversion — doing it on the main thread would pull the whole
 * parser into the entry chunk.
 */
export type ToWorker =
  | { type: 'probe'; probeId: string; file: Blob; fileName: string }
  | {
      type: 'convert';
      jobId: string;
      file: Blob;
      fileName: string;
      target: FormatId;
      params: Record<string, unknown>;
    }
  | { type: 'cancel'; jobId: string };

export type FromWorker =
  | { type: 'probed'; probeId: string; profile: MediaProfile }
  | { type: 'probe-failed'; probeId: string; message: string }
  | { type: 'progress'; jobId: string; progress: JobProgress }
  | {
      type: 'done';
      jobId: string;
      output: Blob;
      outputName: string;
      engineId: string;
      did: 'transmux' | 'transcode';
      extraLosses: LossItem[];
      /** A second file that belongs with the first — Apple's Live Photo is a pair. */
      companion?: { blob: Blob; name: string };
    }
  | { type: 'error'; jobId: string; message: string; code: string };

const engines: Engine[] = [
  // Live Photo first: splitting a bundle has to happen before any generic handling,
  // or an exported still would carry stale Motion Photo metadata along with it.
  new LivePhotoEngine(),
  new ImageEngine(),
  new MediabunnyEngine(),
  new AnimationEngine(),
  // Last resort: 32 MB and an order of magnitude slower. Only the operations nothing
  // else can do are routed here — see docs/specs/engine-routing.md.
  new FfmpegEngine(),
];

/** Did this engine simply not recognise the source, rather than genuinely fail? */
function isUnsupported(error: unknown): boolean {
  return (error as { code?: string })?.code === 'unsupported';
}

/**
 * Run a job through the tier order.
 *
 * Engines are tried cheapest-first, and an engine that cannot *read the source* steps
 * aside for the next one. That fall-through matters for GIF: Mediabunny claims the video
 * containers but cannot parse a GIF, and the animation engine behind it can. Any failure
 * that is not "wrong engine" propagates immediately rather than being retried blind.
 */
async function runWithFallback(request: EngineRequest): Promise<Awaited<ReturnType<Engine['run']>>> {
  let unsupported: unknown;

  for (const engine of engines) {
    if (!engine.supports(request.target)) continue;
    try {
      return await engine.run(request);
    } catch (error) {
      if (!isUnsupported(error)) throw error;
      unsupported = error;
    }
  }

  throw unsupported instanceof Error
    ? unsupported
    : new EngineError(`没有引擎可以输出 ${request.target}`, 'unsupported');
}

/**
 * Extract something a person can act on from whatever was thrown.
 *
 * A narrow `error.message` read loses everything when the thrown value is not an Error —
 * a library rejecting with a string, or a `DOMException` whose message is empty — and the
 * user is left with "the conversion failed" and no way to find out why.
 */
function describeError(cause: unknown): { message: string; code: string } {
  const code = (cause as { code?: string })?.code ?? 'unknown';

  if (cause instanceof Error && cause.message) return { message: cause.message, code };
  if (typeof cause === 'string' && cause.trim()) return { message: cause, code };

  try {
    const json = JSON.stringify(cause);
    if (json && json !== '{}') return { message: json, code };
  } catch {
    // Circular or otherwise unserialisable; fall through to String().
  }

  const text = String(cause).trim();
  return { message: text || '转换失败，且未能取得具体原因', code };
}

/** One AbortController per in-flight job, so cancellation is precise. */
const controllers = new Map<string, AbortController>();

const post = (m: FromWorker) => self.postMessage(m);

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;

  if (msg.type === 'cancel') {
    controllers.get(msg.jobId)?.abort();
    return;
  }

  if (msg.type === 'probe') {
    // Answer either way. `probe` is written never to reject, but this is the only place
    // the caller's promise can be settled, so an unexpected throw must still produce a
    // reply: silence here strands the card at 「识别中」 forever, which reads as the app
    // having hung rather than as one file it could not read.
    try {
      const profile = await probe(msg.file, msg.fileName);
      post({ type: 'probed', probeId: msg.probeId, profile });
    } catch (cause) {
      post({
        type: 'probe-failed',
        probeId: msg.probeId,
        message: describeError(cause).message,
      });
    }
    return;
  }

  if (msg.type !== 'convert') return;

  const { jobId, file, fileName, target, params } = msg;

  if (controllers.has(jobId)) return; // already running
  const controller = new AbortController();
  controllers.set(jobId, controller);

  const request: EngineRequest = {
    input: file,
    inputName: fileName,
    target,
    params,
    signal: controller.signal,
    onProgress: (progress) => post({ type: 'progress', jobId, progress }),
  };

  try {
    const result = await runWithFallback(request);
    post({
      type: 'done',
      jobId,
      output: result.output,
      outputName: result.outputName,
      engineId: result.engineId,
      did: result.did,
      extraLosses: result.extraLosses ?? [],
      ...(result.companion ? { companion: result.companion } : {}),
    });
  } catch (cause) {
    const described = describeError(cause);
    post({ type: 'error', jobId, message: described.message, code: described.code });
  } finally {
    controllers.delete(jobId);
  }
};
