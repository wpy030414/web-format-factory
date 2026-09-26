/// <reference lib="webworker" />
import { MediabunnyEngine } from '../engines/mediabunny/index.ts';
import { ImageEngine } from '../engines/image/index.ts';
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
  | { type: 'progress'; jobId: string; progress: JobProgress }
  | {
      type: 'done';
      jobId: string;
      output: Blob;
      outputName: string;
      engineId: string;
      did: 'transmux' | 'transcode';
      extraLosses: LossItem[];
    }
  | { type: 'error'; jobId: string; message: string; code: string };

const engines: Engine[] = [new ImageEngine(), new MediabunnyEngine()];

/**
 * Pick the engine for a target.
 *
 * Order is the tier order: the cheapest engine that can do the job wins. Images need
 * no WASM and no media library, so the still-image engine goes first.
 */
function engineFor(target: FormatId): Engine {
  const engine = engines.find((e) => e.supports(target));
  if (!engine) {
    throw new EngineError(`没有可以输出 ${target} 的引擎`, 'unsupported');
  }
  return engine;
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
    const profile = await probe(msg.file, msg.fileName);
    post({ type: 'probed', probeId: msg.probeId, profile });
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
    const result = await engineFor(target).run(request);
    post({
      type: 'done',
      jobId,
      output: result.output,
      outputName: result.outputName,
      engineId: result.engineId,
      did: result.did,
      extraLosses: result.extraLosses ?? [],
    });
  } catch (cause) {
    const error = cause as { message?: string; code?: string };
    post({
      type: 'error',
      jobId,
      message: error.message ?? '转换失败',
      code: error.code ?? 'unknown',
    });
  } finally {
    controllers.delete(jobId);
  }
};
