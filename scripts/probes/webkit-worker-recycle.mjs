#!/usr/bin/env node
/**
 * 探针：在 WebKit 里，终止一个 worker 能不能把它的内存还回来？
 *
 * 为什么要留着这个脚本：`docs/researches/webkit-gif-batch-memory.md` 量到，
 * 每转换一次文件，WebContent 的 footprint 就涨 35–60 MB，而 JS 层放不掉——那已经
 * 是垃圾，只是 WebKit 不还给系统。于是「每 N 个任务重建一次引擎」看起来是唯一的
 * 结构性手段。但这件事不能推理，只能量：**销毁一个 dedicated worker，到底会不会
 * 让进程把这部分内存吐出来？**
 *
 * 三种可能，结论完全不同：
 *   1. terminate 之后 footprint 掉回去          → 重建引擎是一条真路
 *   2. terminate 不掉，但新 worker 复用那块内存  → 也算有用（账不涨了）
 *   3. terminate 不掉，新 worker 还继续要新的    → 这条路死了，
 *      一个页面生命周期内做不到超大批次，只能分批 + 明确告知用户
 *
 * 用最纯粹的形式问这个问题：不经过应用，就一个 worker、几块大 ArrayBuffer，
 * 「分配 → 丢引用 → 终止 → 再来一轮」。这样量到的因果关系不掺任何应用逻辑。
 *
 * 用法：node scripts/probes/webkit-worker-recycle.mjs [--chunks 200] [--rounds 3]
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webkit } from '@playwright/test';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const CHUNKS = Number(argOf('--chunks', '200')); // 每块 1 MB
const ROUNDS = Number(argOf('--rounds', '3'));

const installMarker = 'ms-playwright/webkit';

function rows() {
  const ps = execFileSync('ps', ['-axo', 'pid=,rss=,args='], { encoding: 'utf8' });
  return ps
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), rss: Number(m[2]), args: m[3] }))
    .filter((r) => r.args.includes(installMarker));
}

/** WebContent 的 phys_footprint（MB）——判「谁会被杀」的那个数，不是 RSS。 */
function footprintMb() {
  const webContent = rows().find((r) => r.args.includes('WebContent'));
  if (!webContent) return null;
  const out = execFileSync('footprint', ['-p', String(webContent.pid)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const m = /Footprint:\s*([\d.]+)\s*(MB|GB|KB)/.exec(out);
  return m ? Math.round(m[2] === 'GB' ? Number(m[1]) * 1024 : m[2] === 'KB' ? Number(m[1]) / 1024 : Number(m[1])) : null;
}

const context = await webkit.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wff-wk-recycle-')), {
  headless: false,
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto('http://localhost:5173');
await page.getByRole('heading', { name: 'Web Format Factory' }).waitFor();

const settle = async (ms = 2500) => {
  await page.waitForTimeout(ms);
  return footprintMb();
};

/** 一个只会「分配 / 丢引用 / 自己报数」的 worker，不碰任何应用代码。 */
async function spawn() {
  await page.evaluate(
    ({ size }) => {
      const code = `
        let held = [];
        self.onmessage = (event) => {
          const { cmd } = event.data;
          if (cmd === 'alloc') {
            held = [];
            for (let i = 0; i < ${size}; i += 1) {
              const buffer = new Uint8Array(1024 * 1024);
              // 每页写一个字节。不写的话这些页全是零页、copy-on-write 指向同一个物理页，
              // 分配 200 MB 在 footprint 上只涨 1 MB——第一版探针就是这么骗过自己的。
              for (let offset = 0; offset < buffer.length; offset += 4096) buffer[offset] = i & 255;
              held.push(buffer);
            }
          } else if (cmd === 'drop') {
            held = [];
          }
          self.postMessage(cmd + ':ok');
        };
      `;
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      window.__wffWorker = new Worker(url);
    },
    { size: CHUNKS },
  );
}

const send = (cmd) =>
  page.evaluate(
    (cmd) => new Promise((resolve) => {
      const worker = window.__wffWorker;
      worker.addEventListener('message', resolve, { once: true });
      worker.postMessage({ cmd });
    }),
    cmd,
  );

const base = await settle();
console.log(`基线 WebContent footprint：${base} MB（每轮分配 ${CHUNKS} MB）\n`);

const trace = [];
for (let round = 1; round <= ROUNDS; round += 1) {
  await spawn();
  await send('alloc');
  const afterAlloc = await settle();
  await send('drop');
  const afterDrop = await settle();
  await page.evaluate(() => window.__wffWorker.terminate());
  const afterTerminate = await settle();

  trace.push({ round, afterAlloc, afterDrop, afterTerminate });
  console.log(
    `第 ${round} 轮  分配后 ${afterAlloc} (+${afterAlloc - base})  丢引用后 ${afterDrop}  终止后 ${afterTerminate}`,
  );
}

const peaks = trace.map((t) => t.afterAlloc);
const growing = peaks[peaks.length - 1] - peaks[0];
const returned = trace[0].afterAlloc - trace[0].afterTerminate;

console.log(
  [
    '',
    '结论：',
    `  - 分配 ${CHUNKS} MB 之后账面涨：${trace[0].afterAlloc - base} MB`,
    `  - 丢掉引用（drop）：${trace[0].afterAlloc - trace[0].afterDrop} MB 被收回`,
    `  - terminate() 之后：${returned} MB 被收回`,
    `  - 第 1 轮峰值 ${peaks[0]} → 第 ${ROUNDS} 轮峰值 ${peaks[peaks.length - 1]}（${growing >= 0 ? '+' : ''}${growing} MB）`,
    growing < CHUNKS / 2
      ? '  ⇒ 新 worker 复用了已释放的内存：**重建引擎这条路成立**。'
      : '  ⇒ 每一轮都要新的内存：**终止 worker 并不归还给系统，重建引擎救不了**。',
  ].join('\n'),
);

await context.close();
