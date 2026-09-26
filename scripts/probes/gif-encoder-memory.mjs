#!/usr/bin/env node
/**
 * 探针：`modern-gif` 的 `Encoder` 在 `flush()` 之前到底替我们扣住了多少内存？
 *
 * 为什么要留着这个脚本：GIF 分段编码（commit e610333）引入了一个像素预算
 * `MAX_GIF_PIXEL_SECONDS = 400_000_000`，注释写着「一个分段最多扣住这么多字节」。
 * 这个数字是从「编码器每帧每像素留一个索引字节」推出来的——**但那是写盘时的中间产物，
 * 不是编码器在内存里持有的东西**。编码器持有的是我们喂进去的 RGBA：
 * `_encodingFrames.push({ ...frame, data })`，直到 `flush()` 才 `= []`。
 *
 * 于是预算被悄悄放大了 4 倍，而页面崩溃（Chrome「因为出现问题，此网页已重新加载」）
 * 是它唯一的表现形式。这条结论是关于别人家的库的，而那种东西会在一次小版本升级里悄悄变，
 * 所以留着脚本、不要只留注释。
 *
 * 用法：node scripts/probes/gif-encoder-memory.mjs
 */

import { Encoder } from 'modern-gif';

const WIDTH = 640;
const HEIGHT = 360;
const FRAMES = 128;
const PIXELS_PER_FRAME = WIDTH * HEIGHT;

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** 每一帧都不一样的渐变——纯色会把调色板与写盘的工作量抹掉，测出来的就不是真实占用。 */
function frame(seed) {
  const data = new Uint8ClampedArray(PIXELS_PER_FRAME * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * 4;
      data[i] = (x + seed * 3) & 255;
      data[i + 1] = (y + seed * 7) & 255;
      data[i + 2] = (x + y + seed * 11) & 255;
      data[i + 3] = 255;
    }
  }
  return data;
}

/**
 * V8 里由类型化数组持有的那部分内存。
 *
 * `heapUsed` 看不见它——`Uint8ClampedArray` 的字节在 ArrayBuffer 里，不在老生代里。
 * 浏览器里的等价物是进程的 ArrayBuffer 总量，而「页面被 OOM 掉」正是按总量算的。
 */
const arrayBuffers = () => process.memoryUsage().arrayBuffers;
const rss = () => process.memoryUsage().rss;

/** 一边跑一边采样，用来抓 `flush()` 那一刻的峰值。 */
function pollPeak(intervalMs = 5) {
  let peakAb = arrayBuffers();
  let peakRss = rss();
  const timer = setInterval(() => {
    peakAb = Math.max(peakAb, arrayBuffers());
    peakRss = Math.max(peakRss, rss());
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    return { peakAb, peakRss };
  };
}

console.log(`分辨率 ${WIDTH}×${HEIGHT}（${(PIXELS_PER_FRAME / 1e6).toFixed(2)} M 像素），${FRAMES} 帧`);
console.log(`一帧 RGBA 的原始字节：${mb(PIXELS_PER_FRAME * 4)}\n`);

const encoder = new Encoder({
  width: WIDTH,
  height: HEIGHT,
  maxColors: 255,
  dither: 'floyd-steinberg',
});

const before = arrayBuffers();
const samples = [];

for (let i = 0; i < FRAMES; i += 1) {
  await encoder.encode({ data: frame(i), delay: 33 });
  samples.push(arrayBuffers() - before);
}

const heldBeforeFlush = arrayBuffers() - before;
const stopPoll = pollPeak();
const blob = await encoder.flush('blob');
const { peakAb, peakRss } = stopPoll();
const heldAfterFlush = arrayBuffers() - before;

console.log('帧数    持有量(自起点累计)');
for (const n of [1, 8, 32, 64, 128]) {
  const value = samples[n - 1];
  if (value === undefined) continue;
  console.log(
    `${String(n).padStart(4)}    ${mb(value).padStart(9)}   每帧 ${mb(value / n).padStart(8)}`,
  );
}

const perFrame = heldBeforeFlush / FRAMES;
const perPixelPerFrame = perFrame / PIXELS_PER_FRAME;

console.log(
  [
    '',
    `flush() 之前编码器扣住：   ${mb(heldBeforeFlush)}（${FRAMES} 帧，每帧 ${mb(perFrame)}）`,
    `flush() 期间进程峰值 AB：  ${mb(peakAb)}   RSS 峰值 ${mb(peakRss)}`,
    `flush() 之后释放到：       ${mb(heldAfterFlush)}`,
    `产物 GIF：                 ${mb(blob.size)}`,
    '',
    `实测每像素每帧持有：${perPixelPerFrame.toFixed(2)} 字节`,
    '',
    '结论：',
    `  - 编码器在 flush() 之前持有的是喂进去的 RGBA，即每像素每帧 ${perPixelPerFrame.toFixed(1)} 字节，`,
    '    不是注释里写的 1 字节（那 1 字节是写盘时的索引帧，随管线流过，不驻留）。',
    `  - flush() 本身还会在已有的持有量之上再叠一层（索引帧 + 产物累积），`,
    `    所以峰值出现在分段边界那一刻，而不是慢慢涨到顶。`,
    '  - 因此 MAX_GIF_PIXEL_SECONDS 的每个单位实际是 4 字节：',
    `    400M px·s ≈ 1080p@193 帧 ≈ ${mb(1080 * 1920 * 4 * 193)} 常驻，翻两倍并发就是 ${mb(2 * 1080 * 1920 * 4 * 193)}。`,
    '  - 换一个分辨率不改变这个数：预算按像素算，而每像素的字节数是常数。',
    '  - 真正的上限应当是**字节**，且要算进 flush 那一层余量。',
  ].join('\n'),
);
