#!/usr/bin/env node
/**
 * 探针：`modern-gif` 的 `delay` 到底是什么单位，写盘时又对它做了什么？
 *
 * 为什么要留着这个脚本：动画引擎曾经把厘秒喂给这个参数，于是每一帧的延迟都写成
 * 了 0，而渲染器把 0 按 Netscape 时代的兼容规则抬到 100 毫秒——产物播成 10fps。
 * 当时的类型定义里 `delay: number` 没有单位注释，唯一靠谱的办法是把编码器真的
 * 跑一遍、再把字节读回来。
 *
 * 这是 `src/engines/animation/timing.ts` 与 `docs/researches/gif-frame-timing.md`
 * 背后的证据，也是 `tests/unit/gif-encoder-delay.test.ts` 所钉住的那条契约的出处。
 * 更要紧的是：这条结论是关于别人家的库的，而那种东西会在一次小版本升级里悄悄变。
 *
 * 用法：node scripts/probes/gif-delay-unit.mjs
 */

import { Encoder, decodeFrames } from 'modern-gif';

const WIDTH = 4;
const HEIGHT = 4;

/** 一帧纯色，足以构成合法 GIF，又没有什么好抖动的。 */
function pixels(shade) {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
    data[i * 4] = shade;
    data[i * 4 + 1] = shade;
    data[i * 4 + 2] = shade;
    data[i * 4 + 3] = 255;
  }
  return data;
}

async function encode(delays) {
  const encoder = new Encoder({ width: WIDTH, height: HEIGHT, maxColors: 16 });
  for (const [index, delay] of delays.entries()) {
    await encoder.encode({ data: pixels(index * 40), delay });
  }
  return new Uint8Array(await (await encoder.flush('blob')).arrayBuffer());
}

/** 逐条读出 Graphic Control Extension 里的 delayTime（单位：厘秒）。 */
function storedDelayTimes(bytes) {
  const found = [];
  for (let i = 0; i + 6 < bytes.length; i += 1) {
    // 0x21 扩展引导符，0xF9 图形控制标签，0x04 块长度。
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
      found.push(bytes[i + 4] | (bytes[i + 5] << 8));
    }
  }
  return found;
}

const CASES = [
  ['3', '引擎旧代码对 30fps 源算出来的值（厘秒）'],
  ['2', '引擎旧代码对 60fps 源算出来的值（厘秒）'],
  ['17', '60fps 源换算成毫秒后的值'],
  ['20', 'GIF 可用下限'],
  ['25', '不是 10 的整数倍'],
  ['30', 'GIF → GIF 路径今天传的值'],
  ['33', '33.3ms 帧换算成毫秒后的值'],
  ['100', '10fps'],
];

console.log('delay 入参 → 写进文件的 delayTime（厘秒）→ 解码器读回（毫秒）\n');

for (const [raw, why] of CASES) {
  const delay = Number(raw);
  const bytes = await encode([delay]);
  const stored = storedDelayTimes(bytes);
  const readBack = decodeFrames(bytes).map((frame) => frame.delay);
  console.log(
    `${String(delay).padStart(4)} ms → delayTime ${JSON.stringify(stored)} → ${JSON.stringify(readBack)} ms   ${why}`,
  );
}

console.log(
  [
    '',
    '结论：',
    '  - `delay` 的单位是毫秒，不是厘秒。',
    '  - 写盘时 `delay / 10` 被向零截断，所以 17 → 1、25 → 2、33 → 3。',
    '  - 因此凡是交给编码器的延迟，都必须先吸附到 10 毫秒栅格上；',
    '    否则截断就是一次安静的、系统性的漂移。',
    '  - delayTime 为 0（或 1）时渲染器抬到 100 毫秒——这条不是本脚本量出来的，',
    '    是浏览器的兼容行为，出处见 docs/researches/gif-frame-timing.md。',
  ].join('\n'),
);
