import type { FormatId } from '../core/types.ts';
import type { LossItem } from '../core/loss/codes.ts';

/** Where a job is in its lifecycle. Rendered directly by the UI. */
export type JobPhase =
  | 'loading-engine'
  | 'probing'
  | 'decoding'
  | 'encoding'
  | 'muxing'
  | 'finalizing'
  | 'verifying';

export interface JobProgress {
  phase: JobPhase;
  /**
   * 0..1, or `undefined` for indeterminate work.
   *
   * Indeterminate is a real state, not a failure to compute one — a stream copy has
   * no known output duration, and a fabricated percentage is worse than an honest
   * barber pole. The UI must render `undefined` as indeterminate.
   */
  ratio?: number;
  label?: string;
  frames?: { done: number; total: number };
}

/** Everything an engine needs to do its work. */
export interface EngineRequest {
  /** The source bytes. A Blob, so large inputs are not held in JS memory. */
  input: Blob;
  /** Source file name, used to derive the output name. */
  inputName: string;
  /** What the user asked for. */
  target: FormatId;
  /** Encoding parameters, already filtered to the target's schema. */
  params: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  onProgress?: (progress: JobProgress) => void;
}

export interface EngineResult {
  output: Blob;
  outputName: string;
  /** The engine that actually did the work — surfaced in the result report. */
  engineId: string;
  /** What it actually did, which may differ from what was requested. */
  did: 'transmux' | 'transcode';
  /** Losses discovered only at execution time, on top of the ones predicted. */
  extraLosses?: LossItem[];
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'unsupported'
      | 'decode-failed'
      | 'encode-failed'
      | 'aborted'
      | 'engine-unavailable'
      | 'out-of-memory',
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

/** Every engine adapter implements this. */
export interface Engine {
  readonly id: string;
  /** Can this engine do this conversion at all? Cheap, synchronous, no I/O. */
  supports(target: FormatId): boolean;
  run(request: EngineRequest): Promise<EngineResult>;
}

/** Derive an output file name by swapping the extension. */
export function outputNameFor(inputName: string, extension: string): string {
  const base = inputName.replace(/\.[^./\\]+$/, '') || 'output';
  return `${base}.${extension}`;
}
