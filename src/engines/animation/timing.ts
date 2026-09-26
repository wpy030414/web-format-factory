/**
 * GIF frame timing.
 *
 * GIF stores each frame's delay as a 16-bit count of centiseconds, so 10 ms is the finest
 * interval the format can *express*. Two facts about that count decide everything here:
 *
 * 1. The floor is 20 ms, not 10. Renderers have clamped anything shorter to 100 ms since
 *    the Netscape era, so a 10 ms frame is not a fast frame — it is a frame that plays for
 *    a tenth of a second. 50 fps is therefore the fastest a GIF can honestly play.
 *    See `docs/researches/gif-frame-timing.md`.
 * 2. The encoder floors. `modern-gif` writes `delay / 10` into the centisecond field, so a
 *    delay that is not a whole number of 10 ms steps is silently rounded *down*. Every
 *    value this module produces is therefore snapped to that grid — which also makes the
 *    rounding a no-op rather than a slow, systematic drift.
 *
 * Deliberately pure and free of any import: the arithmetic is the part that was wrong, and
 * it is the part worth testing without a browser, a decoder or an encoder in the way.
 */

/** The grid GIF delays live on: one centisecond. */
export const GIF_DELAY_GRID_MS = 10;

/** The shortest delay a renderer will actually honour — see the header. */
export const GIF_MIN_DELAY_MS = 20;

/** A 16-bit centisecond count is the most a graphic control extension can hold. */
export const GIF_MAX_DELAY_MS = 65_535 * GIF_DELAY_GRID_MS;

/** What a frame with no usable timing gets. Matches what renderers do with a zero delay. */
export const DEFAULT_FRAME_DELAY_MS = 100;

/** Snap a time onto the delay grid. */
export function snapToGrid(ms: number): number {
  return Math.round(ms / GIF_DELAY_GRID_MS) * GIF_DELAY_GRID_MS;
}

/** Force a value into something a GIF can hold. Never returns 0, NaN or a negative. */
export function clampDelay(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_FRAME_DELAY_MS;
  return Math.min(GIF_MAX_DELAY_MS, Math.max(GIF_MIN_DELAY_MS, snapToGrid(ms)));
}

/**
 * A delay for a *video* target, in seconds.
 *
 * The 20 ms floor is a property of GIF's renderers, not of a frame's duration: a video
 * container carries exact timestamps, so a 10 ms source frame stays 10 ms on the way out.
 * The grid is still applied — that is how the delay was stored.
 */
export function delaySecondsForVideo(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return DEFAULT_FRAME_DELAY_MS / 1000;
  return Math.max(GIF_DELAY_GRID_MS, snapToGrid(delayMs)) / 1000;
}

/* ------------------------------------------------------------------ what we measured */

/** Frame-rate facts as measured from real packet timestamps. */
export interface FrameRateFacts {
  /** Frames per second averaged over the probed packets. */
  average: number;
  /** Derived from the *tightest* gap — i.e. the fastest instant in the track. */
  max: number;
  /** True only for a constant-rate track with no skipped frames. */
  constant: boolean;
}

/**
 * How to lay a source's frames onto a timeline GIF can hold.
 *
 * - `cumulative` keeps every frame whose own span can be expressed, which covers the
 *   ordinary cases (24/25/30/50 fps, variable frame rate, slideshows) exactly.
 * - `grid` samples a uniformly faster source onto the 20 ms grid instead. Sampling it
 *   frame by frame would emit delays alternating between 20 and 30 ms — an average of
 *   40 fps, lumpier *and* keeping fewer frames than the format can hold.
 *
 * The measurement is taken again, independently, by the probe for the loss report. The two
 * deliberately do not share a value: this one decides what the encoder writes, the other
 * decides what the user is told, and each is derived from what its own side can see.
 */
export type TimingRegime = 'cumulative' | 'grid';

export function decideRegime(
  facts: FrameRateFacts | undefined,
  floorMs: number = GIF_MIN_DELAY_MS,
): TimingRegime {
  if (!facts) return 'cumulative';
  if (!Number.isFinite(facts.average) || facts.average <= 0) return 'cumulative';
  return facts.constant && facts.average > 1000 / floorMs ? 'grid' : 'cumulative';
}

/* ------------------------------------------------------------------ cumulative */

export interface CumulativeStep {
  /** The delay to write for the frame that just closed, or `null` if it was dropped. */
  delayMs: number | null;
  /** Where the timeline now stands: the end of the last frame actually written. */
  cursorMs: number;
}

/**
 * Close one frame.
 *
 * The delay is measured from where the last *written* frame ended to where this one does,
 * both snapped to the grid — not from this frame's own interval. That is what keeps a
 * 29.97 fps source from playing 11 % fast and short: the individual intervals round, the
 * cumulative timeline does not drift.
 *
 * A frame that cannot be given its own span is dropped rather than written with a delay a
 * renderer would stretch to 100 ms. Its time is absorbed by the next frame that is
 * written, so the total duration still matches the source; the cost is that a kept frame
 * may lead its true timestamp by up to one dropped span.
 */
export function stepCumulative(
  endMs: number,
  cursorMs: number,
  floorMs: number = GIF_MIN_DELAY_MS,
): CumulativeStep {
  if (!Number.isFinite(endMs)) return { delayMs: null, cursorMs };
  const snapped = snapToGrid(endMs);
  const span = snapped - cursorMs;
  return span >= floorMs ? { delayMs: span, cursorMs: snapped } : { delayMs: null, cursorMs };
}

/* ------------------------------------------------------------------------ grid */

export interface GridPlan {
  /** Timestamps to sample the source at, in milliseconds from the track's origin. */
  stampsMs: number[];
  /** The delay each sampled frame carries, in the same order. */
  delaysMs: number[];
}

/**
 * Sample a uniformly fast source onto the delay floor's grid.
 *
 * `slots` is floored, not rounded, and the last slot absorbs the remainder — so the total
 * is exact to within the grid rather than overshooting by up to a whole slot.
 */
export function planGrid(
  originMs: number,
  trackEndMs: number,
  floorMs: number = GIF_MIN_DELAY_MS,
): GridPlan {
  const start = snapToGrid(originMs);
  const end = snapToGrid(trackEndMs);
  const span = Math.max(floorMs, end - start);
  const slots = Math.max(1, Math.floor(span / floorMs));

  const stampsMs: number[] = [];
  const delaysMs: number[] = [];
  for (let slot = 0; slot < slots; slot += 1) {
    // Look up at the slot's centre: the same frame count as looking at its start, with
    // half the worst-case distance from the frame the source actually meant.
    stampsMs.push(start + slot * floorMs + floorMs / 2);
    delaysMs.push(slot === slots - 1 ? clampDelay(span - slot * floorMs) : floorMs);
  }

  return { stampsMs, delaysMs };
}
