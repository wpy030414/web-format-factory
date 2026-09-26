import { describe, expect, it } from 'vitest';

import {
  clampDelay,
  decideRegime,
  DEFAULT_FRAME_DELAY_MS,
  delaySecondsForVideo,
  GIF_MAX_DELAY_MS,
  GIF_MIN_DELAY_MS,
  planGrid,
  snapToGrid,
  stepCumulative,
} from '@/engines/animation/timing.ts';

/**
 * GIF frame timing.
 *
 * This is the arithmetic that was wrong: the engine handed the encoder centiseconds where
 * it wanted milliseconds, so every frame's delay was written as zero and renderers — which
 * stretch a zero delay to 100 ms — played the result at 10 fps. A bug that reads as "the
 * frame rate is wrong" is really a unit and rounding bug, and it is worth pinning here,
 * without a browser or an encoder in the way, before anything else.
 *
 * Scope note: these are the *rules*. That `modern-gif` interprets a delay as milliseconds,
 * and floors it, is asserted separately against the real encoder in
 * `gif-encoder-delay.test.ts` — this file takes both facts as given and pins what we build
 * on top of them.
 */

/** Walk a constant-rate source through the cumulative machine, frame by frame. */
function runCumulative(fps: number, durationMs: number, originMs = 0) {
  const interval = 1000 / fps;
  let cursor = snapToGrid(originMs);
  const delays: number[] = [];
  let dropped = 0;
  let lastEnd = originMs;

  // Computed from the index rather than accumulated, so a 30 fps source's last frame
  // lands on 1000 ms and not on 999.9999 — the tests are about timing, not float drift.
  for (let index = 1; ; index += 1) {
    const end = originMs + index * interval;
    if (end > durationMs + 1e-9) break;
    const step = stepCumulative(end, cursor);
    if (step.delayMs === null) dropped += 1;
    else {
      delays.push(step.delayMs);
      cursor = step.cursorMs;
    }
    lastEnd = end;
  }

  return {
    delays,
    dropped,
    cursor,
    lastEnd,
    total: delays.reduce((sum, d) => sum + d, 0),
  };
}

describe('GIF 时序 — 延迟必须落在格式能表达的栅格上', () => {
  it('把时间吸附到 10 毫秒的整数倍', () => {
    expect(snapToGrid(33.33)).toBe(30);
    expect(snapToGrid(35)).toBe(40);
    expect(snapToGrid(1000)).toBe(1000);
  });

  it('永不产出 0、NaN 或负数——它们都会被渲染器拉成 100 毫秒', () => {
    for (const input of [0, -50, Number.NaN, Number.POSITIVE_INFINITY, 1]) {
      const delay = clampDelay(input);
      expect(delay).toBeGreaterThanOrEqual(GIF_MIN_DELAY_MS);
      expect(delay % 10).toBe(0);
    }
    expect(clampDelay(Number.NaN)).toBe(DEFAULT_FRAME_DELAY_MS);
  });

  it('夹住 16 位厘秒计数装不下的超长延迟', () => {
    // A single-frame "video" an hour long would otherwise wrap the graphic control
    // extension and produce a GIF that plays for a fifth of a second.
    expect(clampDelay(3_600_000)).toBe(GIF_MAX_DELAY_MS);
  });
});

describe('累积对齐 — 帧间隔在栅格上取整，累积时间轴不漂', () => {
  it('10 / 25 / 50 fps 每一步都恰好落在栅格上，一个字节都不多不少', () => {
    for (const [fps, expected] of [[10, 100], [25, 40], [50, 20]] as const) {
      const { delays, dropped, total } = runCumulative(fps, 1000);
      expect(new Set(delays)).toEqual(new Set([expected]));
      expect(dropped).toBe(0);
      expect(total).toBe(1000);
    }
  });

  it('30 fps：单帧间隔在 30 与 40 之间取整，但总长仍是 1000 毫秒', () => {
    const { delays, total, dropped } = runCumulative(30, 1000);
    expect(new Set(delays)).toEqual(new Set([30, 40]));
    expect(dropped).toBe(0);
    // Thirty frames each floored to 30 ms would come to 900 ms — the clip would run
    // 10 % fast and short. Measured from the cumulative timeline, it does not.
    expect(total).toBe(1000);
  });

  it('29.97 fps：总长跟住最后一阵的时间戳，而不是每帧各自向下取整', () => {
    const { total, lastEnd, delays } = runCumulative(29.97, 1000);
    expect(total).toBe(snapToGrid(lastEnd));
    // The floor-every-interval bug would have made every one of these 30 ms.
    expect(delays.every((d) => d >= 30 && d <= 40)).toBe(true);
  });

  it('45 fps：每一帧都装得下，于是帧数一帧不减', () => {
    const { delays, dropped, total } = runCumulative(45, 1000);
    expect(dropped).toBe(0);
    expect(delays).toHaveLength(45);
    expect(total).toBe(1000);
  });

  it('首时间戳不从 0 开始时，起点偏移不会被算进第一帧', () => {
    const { delays } = runCumulative(10, 1500, 500);
    // Frame one spans 500 → 600 ms from the track's own origin: 100 ms, not 600.
    expect(delays[0]).toBe(100);
    expect(delays.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('丢帧只丢装不下的，它的时间由下一帧吸收，总长不变', () => {
    // A rate that is fine except for one fast frame: that one is dropped, the rest are
    // kept, and the timeline still ends where the source ended.
    let cursor = 0;
    const kept: number[] = [];
    let dropped = 0;
    for (const end of [100, 200, 210, 300, 400]) {
      const step = stepCumulative(end, cursor);
      if (step.delayMs === null) dropped += 1;
      else {
        kept.push(step.delayMs);
        cursor = step.cursorMs;
      }
    }
    expect(dropped).toBe(1);
    expect(kept).toEqual([100, 100, 100, 100]);
    expect(kept.reduce((a, b) => a + b, 0)).toBe(400);
  });

  it('不可用的时间戳不会被写成延迟', () => {
    expect(stepCumulative(Number.NaN, 0).delayMs).toBeNull();
    expect(stepCumulative(Number.POSITIVE_INFINITY, 0).delayMs).toBeNull();
  });
});

describe('抽帧合规 — 源快于 50 fps 时保时长、丢帧', () => {
  it('60 fps 1 秒 → 50 帧，每帧 20 毫秒，总长一毫秒不差', () => {
    const { stampsMs, delaysMs } = planGrid(0, 1000);
    expect(delaysMs).toHaveLength(50);
    expect(new Set(delaysMs)).toEqual(new Set([20]));
    expect(delaysMs.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(stampsMs[0]).toBe(10);
    expect(stampsMs[1]).toBe(30);
  });

  it('120 fps 1 秒 → 同样是 50 帧；GIF 装不下的部分不会变成慢动作', () => {
    const { delaysMs } = planGrid(0, 1000);
    expect(delaysMs).toHaveLength(50);
    // Playing all 120 frames at the 20 ms floor would have run 2400 ms for a 1000 ms
    // clip — 2.4x slow motion. Keeping 50 frames keeps the real time.
    expect(delaysMs.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('时长不是整槽时，末槽吸收余数，总长仍然精确', () => {
    const { delaysMs } = planGrid(0, 1010);
    expect(delaysMs).toHaveLength(50);
    expect(delaysMs.at(-1)).toBe(30);
    expect(delaysMs.reduce((a, b) => a + b, 0)).toBe(1010);
  });

  it('源不从 0 开始时，槽位跟着原点走', () => {
    const { stampsMs, delaysMs } = planGrid(500, 1500);
    expect(stampsMs[0]).toBe(510);
    expect(delaysMs.reduce((a, b) => a + b, 0)).toBe(1000);
  });
});

describe('制式选择 — 恒速且够快才抽帧', () => {
  it('恒速 60 fps 走抽帧；恒速 30 fps 走累积对齐', () => {
    expect(decideRegime({ average: 60, max: 60, constant: true })).toBe('grid');
    expect(decideRegime({ average: 30, max: 30, constant: true })).toBe('cumulative');
  });

  it('稀疏的可变帧率不抽帧——一段爆发不能把整段录屏拉成几千槽', () => {
    // A screen recording: mostly still, 60 fps while scrolling. Resampling this onto the
    // 20 ms grid would invent ~3000 slots for 200 real frames and then hit the frame
    // ceiling, refusing a conversion that works today.
    expect(decideRegime({ average: 3.3, max: 60, constant: false })).toBe('cumulative');
  });

  it('探针没给出帧率时，选保守的那个', () => {
    expect(decideRegime(undefined)).toBe('cumulative');
    expect(decideRegime({ average: Number.NaN, max: 60, constant: true })).toBe('cumulative');
  });
});

describe('GIF → 视频：目标是视频容器，不受 GIF 渲染器那 20 毫秒底线的约束', () => {
  it('10 毫秒的源帧仍然是 10 毫秒', () => {
    expect(delaySecondsForVideo(10)).toBeCloseTo(0.01, 6);
  });

  it('缺失或为零的延迟回退到 100 毫秒，而不是零', () => {
    expect(delaySecondsForVideo(0)).toBeCloseTo(DEFAULT_FRAME_DELAY_MS / 1000, 6);
    expect(delaySecondsForVideo(Number.NaN)).toBeCloseTo(DEFAULT_FRAME_DELAY_MS / 1000, 6);
  });
});
