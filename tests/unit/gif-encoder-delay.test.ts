import { describe, expect, it } from 'vitest';
import { Encoder, decodeFrames } from 'modern-gif';

/**
 * The encoder's delay unit, asserted against the encoder itself.
 *
 * `modern-gif` types `delay` as a bare `number` with no unit, and the engine used to read
 * it as centiseconds — which is the bug this whole change is about. The mistake survived
 * because it was invisible in a browser: a delay written as zero is stretched to 100 ms by
 * the renderer, so the output *looked* right while the file said something else entirely.
 *
 * So the assumption is pinned here, against real bytes, the way `alpha.test.ts` pins GIF89a
 * by hand: read the graphic control extension back out and compare. If a future version of
 * the encoder changes its unit, this file goes red instead of the frame rate going quiet.
 *
 * What it settles:
 *   - `delay` is milliseconds
 *   - the encoder floors `delay / 10` into the centisecond field
 *   - therefore a delay that is already a whole number of 10 ms steps survives untouched
 */

const WIDTH = 4;
const HEIGHT = 4;

/**
 * A frame of one flat colour — enough bytes for a valid GIF, nothing to dither.
 *
 * The buffer parameter is spelled out because the encoder's types insist on a plain
 * `ArrayBuffer`: the default `ArrayBufferLike` admits a `SharedArrayBuffer`, which these
 * bytes never are. Same narrowing the engine does at its call sites.
 */
function pixels(shade: number): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
    data[i * 4] = shade;
    data[i * 4 + 1] = shade;
    data[i * 4 + 2] = shade;
    data[i * 4 + 3] = 255;
  }
  return data;
}

async function encode(delays: number[]): Promise<Uint8Array<ArrayBuffer>> {
  const encoder = new Encoder({ width: WIDTH, height: HEIGHT, maxColors: 16 });
  for (const [index, delay] of delays.entries()) {
    await encoder.encode({ data: pixels(index * 40), delay });
  }
  return new Uint8Array(await (await encoder.flush('blob')).arrayBuffer());
}

/** Every graphic control extension's delay field, in centiseconds as stored. */
function storedDelays(bytes: Uint8Array): number[] {
  const found: number[] = [];
  for (let i = 0; i + 6 < bytes.length; i += 1) {
    // 0x21 extension introducer, 0xF9 graphic control label, 0x04 block size.
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
      // Little-endian 16-bit count, one centisecond per unit.
      found.push((bytes[i + 4] ?? 0) | ((bytes[i + 5] ?? 0) << 8));
    }
  }
  return found;
}

describe('modern-gif 的 delay 单位是毫秒，且写盘时向零截断', () => {
  it('毫秒值落在厘秒字段上：30 毫秒写成 3', async () => {
    expect(storedDelays(await encode([30, 30, 30]))).toEqual([3, 3, 3]);
    expect(storedDelays(await encode([100]))).toEqual([10]);
  });

  it('10 倍小的值会被截断成 0——这正是原 bug 写出来的东西', async () => {
    // What `videoToGif` used to pass for a 30 fps source. A zero delay is not "as fast as
    // possible": renderers stretch it to 100 ms, which is the 10 fps the user reported.
    expect(storedDelays(await encode([3, 3, 3]))).toEqual([0, 0, 0]);
    // And 17 ms truncates to 1 rather than rounding to 2, which is why every delay we
    // hand over is snapped to the grid first: the floor must not be a silent drift.
    expect(storedDelays(await encode([17]))).toEqual([1]);
    expect(storedDelays(await encode([25]))).toEqual([2]);
  });

  it('已经落在 10 毫秒栅格上的延迟原样通过', async () => {
    expect(storedDelays(await encode([20, 40, 100]))).toEqual([2, 4, 10]);
  });

  it('解码器读回来的是毫秒，与写进去的对称', async () => {
    const decoded = decodeFrames(await encode([20, 100]));
    expect(decoded.map((frame) => frame.delay)).toEqual([20, 100]);
  });

  it('零延迟解码回来是 100 毫秒，而不是 10 毫秒', async () => {
    // The renderer compatibility rule, seen from the decoder's side.
    const decoded = decodeFrames(await encode([0, 0]));
    expect(decoded.map((frame) => frame.delay)).toEqual([100, 100]);
  });
});
