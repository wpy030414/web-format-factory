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
   * Indeterminate is a real state, not a failure to compute one: the image engine, the
   * animation stack's frames→video path and Live Photo's phase markers never report a
   * ratio. The UI must render `undefined` as indeterminate — and must not invent a reason
   * for it. (A stream copy is *not* the reason: Mediabunny derives its ratio from track
   * durations and reports one for copies just as it does for encodes.)
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
  /**
   * Every file the engine produced.
   *
   * Almost every conversion produces exactly one entry. Two common exceptions:
   *
   *   1. The Apple Live Photo path, which returns a still image and a short movie as a pair
   *      that belong together.
   *   2. The GIF path for videos whose pixel budget exceeds one segment — the engine splits
   *      the timeline into independently encoded parts so that each stays within a safe
   *      memory ceiling.
   */
  outputs: Array<{ blob: Blob; name: string }>;
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

/**
 * Derive an output file name by swapping the extension.
 *
 * When `segmentIndex` is provided (0-based), an `_02` / `_03` suffix is inserted before
 * the extension. Segment 0 (or undefined) produces no suffix, so the first part of a
 * multi-file result has the same plain name as a single-file conversion.
 */
export function outputNameFor(inputName: string, extension: string, segmentIndex?: number): string {
  const base = inputName.replace(/\.[^./\\]+$/, '') || 'output';
  if (segmentIndex !== undefined && segmentIndex > 0) {
    return `${base}_${String(segmentIndex + 1).padStart(2, '0')}.${extension}`;
  }
  return `${base}.${extension}`;
}

/**
 * Our parameters are 0–100; every encoder underneath wants 0–1.
 *
 * One function rather than one per engine, because the per-engine copies had already
 * drifted: the image engine normalised, and the other two passed the raw percentage
 * through. That omission was invisible from the outside for a long time — Mediabunny
 * turns a quality into a *quantizer* where the codec allows one, and clamps anything
 * outside 0–1 back into range, so VP9 quietly encoded at maximum quality and the slider
 * was inert. It surfaced only where no quantizer was available: H.264 had to fall back to
 * the bitrate the bogus scale produces — 0.3·e^(2.5538·75), about 10^86 bits per second —
 * and the encoder rejected the config outright. Every 动图 → MP4/MOV/MKV was a route that
 * could only fail, and nothing tested it.
 *
 * @param fallback used when the parameter is absent or not a number.
 */
export function qualityFraction(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(1, Math.max(0, value / 100));
}
