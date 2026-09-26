import type { FormatId } from '../core/types.ts';
import type { LossItem } from '../core/loss/codes.ts';
import type { MediaProfile } from '../core/probe/profile.ts';
import { withDeadline } from '../core/deadline.ts';
import { EngineError, type JobProgress } from './types.ts';
import type { FromWorker, ToWorker } from '../workers/media.worker.ts';

export interface ConvertOptions {
  jobId: string;
  file: Blob;
  fileName: string;
  target: FormatId;
  params: Record<string, unknown>;
  /**
   * The whole `JobProgress`, not just its ratio.
   *
   * Narrowing it here to a number would throw away the phase, the label and the frame
   * count — the only things that let the UI say what is actually happening while a job
   * reports no percentage.
   */
  onProgress?: (progress: JobProgress) => void;
  signal?: AbortSignal;
}

export interface ConvertOutcome {
  outputs: Array<{ blob: Blob; name: string }>;
  engineId: string;
  did: 'transmux' | 'transcode';
  extraLosses: LossItem[];
}

interface PendingJob {
  resolve: (outcome: ConvertOutcome) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: JobProgress) => void;
}

interface PendingProbe {
  resolve: (profile: MediaProfile) => void;
  reject: (error: Error) => void;
}

let probeCounter = 0;

/**
 * How long a probe may take before it is declared lost.
 *
 * Generous to the point of being unreachable by real work: the probe reads a 64 KB header
 * and, for a JPEG or a `.livp`, the file's own bytes — no probe of a file a person would
 * actually drop has any business taking a minute. It is here for the one case that has no
 * other way out: a worker that never answers at all. Nothing below this layer can recover
 * from that, so the card would otherwise read 「识别中」 for as long as the tab stays open,
 * with no error and no way to tell it apart from a hang.
 */
const PROBE_DEADLINE_MS = 60_000;

/**
 * Main-thread handle for the media worker.
 *
 * The worker exists so a long conversion cannot freeze the page, and so the media
 * library never lands in the entry chunk. It holds one engine instance for its
 * lifetime — spinning a worker up per job would re-parse the library every time.
 */
export class MediaEngineClient {
  private readonly worker: Worker;
  private readonly jobs = new Map<string, PendingJob>();
  private readonly probes = new Map<string, PendingProbe>();

  constructor() {
    this.worker = new Worker(new URL('../workers/media.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.handle(event.data);
    this.worker.onerror = (event) => {
      // A worker-level failure is not attributable to one job, so fail them all rather
      // than leaving promises hanging forever.
      const error = new Error(event.message || '转换进程异常退出');
      for (const [, p] of this.jobs) p.reject(error);
      for (const [, p] of this.probes) p.reject(error);
      this.jobs.clear();
      this.probes.clear();
    };
  }

  private handle(msg: FromWorker): void {
    if (msg.type === 'probed' || msg.type === 'probe-failed') {
      const pending = this.probes.get(msg.probeId);
      this.probes.delete(msg.probeId);
      if (!pending) return;
      if (msg.type === 'probed') pending.resolve(msg.profile);
      else pending.reject(new EngineError(msg.message, 'decode-failed'));
      return;
    }

    const pending = this.jobs.get(msg.jobId);
    if (!pending) return;

    if (msg.type === 'progress') {
      pending.onProgress?.(msg.progress);
      return;
    }

    this.jobs.delete(msg.jobId);

    if (msg.type === 'done') {
      pending.resolve({
        outputs: msg.outputs,
        engineId: msg.engineId,
        did: msg.did,
        extraLosses: msg.extraLosses,
      });
      return;
    }

    const error = new Error(msg.message) as Error & { code?: string };
    error.code = msg.code;
    error.name = 'EngineError';
    pending.reject(error);
  }

  /** Identify a file. Runs off the main thread because it needs the media library. */
  probe(file: Blob, fileName: string): Promise<MediaProfile> {
    const probeId = `p${++probeCounter}`;
    const answer = new Promise<MediaProfile>((resolve, reject) => {
      this.probes.set(probeId, { resolve, reject });
      this.post({ type: 'probe', probeId, file, fileName });
    });

    // Last resort, and the only one that survives a worker which has stopped talking
    // altogether. The worker answers every probe it receives — including the ones it
    // cannot identify — so reaching this deadline means the reply is never coming, and
    // saying so is strictly better than an eternal spinner.
    return withDeadline(answer, PROBE_DEADLINE_MS, () => {
      this.probes.delete(probeId);
      throw new EngineError(
        `识别超时（${PROBE_DEADLINE_MS / 1000} 秒没有回应）。请移除这个文件后重新导入。`,
        'engine-unavailable',
      );
    });
  }

  convert(options: ConvertOptions): Promise<ConvertOutcome> {
    const { jobId, file, fileName, target, params, onProgress, signal } = options;

    return new Promise<ConvertOutcome>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('已取消'));
        return;
      }

      // Registered before the job is posted so an abort arriving mid-flight always
      // finds a pending entry to settle.
      const onAbort = () => {
        this.post({ type: 'cancel', jobId });
        this.jobs.delete(jobId);
        reject(new Error('已取消'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.jobs.set(jobId, {
        resolve: (outcome) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(outcome);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        ...(onProgress ? { onProgress } : {}),
      });

      this.post({ type: 'convert', jobId, file, fileName, target, params });
    });
  }

  private post(message: ToWorker): void {
    this.worker.postMessage(message);
  }

  dispose(): void {
    const error = new Error('引擎已关闭');
    for (const [, p] of this.jobs) p.reject(error);
    for (const [, p] of this.probes) p.reject(error);
    this.jobs.clear();
    this.probes.clear();
    this.worker.terminate();
  }
}

/** Narrow an unknown thrown value into a message + code for the UI. */
export function asEngineError(error: unknown): { message: string; code: string } {
  const e = error as { message?: string; code?: string };
  return { message: e?.message ?? '转换失败', code: e?.code ?? 'unknown' };
}
