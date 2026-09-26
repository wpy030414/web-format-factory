#!/usr/bin/env node
/**
 * 探针：给 `CanvasSink` 加池子之后，产出的 GIF 还是同一个吗？
 *
 * 为什么要留着这个脚本：`poolSize: 3` 把「每帧一个新 canvas」换成了「三个 canvas 轮着用」
 * （见 src/engines/animation/index.ts），这是对着 WebKit 的内存增长量出来的一个改动。
 * 池化的失效方式很安静：画布被下一帧覆盖，于是产物只是**画错**，容器、编码、帧时序全都正常——
 * 而 `tests/e2e/convert.spec.ts` 里的 GIF 用例验的恰好全是后者。
 *
 * 所以这里做的是像素级对拍：同一段素材、同一条真实路径（浏览器里跑引擎、走下载），
 * 把产物解回帧、逐帧算摘要，两次跑出来的摘要必须一字不差。
 *
 * 用法：
 *   pnpm dev 起在 5173，然后
 *   node scripts/probes/gif-pool-fidelity.mjs --out /tmp/gif-with-pool.gif [--browser webkit]
 *   改一行再跑一次，比较两次打印的 digests。
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, webkit } from '@playwright/test';
import { decodeFrames } from 'modern-gif';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const OUT = argOf('--out', '/tmp/gif-fidelity.gif');
const BROWSER = argOf('--browser', 'webkit');
const SOURCE = argOf('--source', '/tmp/wff-samples/ref-long.mp4');
const BASE = argOf('--base', 'http://localhost:5173');

const context =
  BROWSER === 'webkit' ? await webkit.launch() : await chromium.launch();
const page = await context.newPage();
await page.goto(BASE);
await page.getByRole('heading', { name: 'Web Format Factory' }).waitFor();

await page.setInputFiles('input[type=file]', SOURCE);
await page.getByTestId('media-class').first().waitFor({ timeout: 60_000 });
await page.getByRole('button', { name: 'GIF', exact: true }).click();
await page.getByRole('button', { name: /开始转换/ }).click();

const downloadButton = page.getByTestId('download-result').first();
await downloadButton.waitFor({ timeout: 180_000 });

const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
await downloadButton.click();
const download = await downloadPromise;
const path = join('/tmp', `wff-fidelity-${Date.now()}.gif`);
await download.saveAs(path);
writeFileSync(OUT, readFileSync(path));
await context.close();

// 解回帧，逐帧算摘要。宽高与延迟一并入账：只比像素会漏掉「帧被画串了但尺寸对」这种。
const bytes = new Uint8Array(readFileSync(path));
const frames = decodeFrames(bytes);
const digests = frames.map((frame, index) =>
  createHash('sha256')
    .update(`#${index} ${frame.width}x${frame.height} ${frame.delay}ms `)
    .update(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength))
    .digest('hex')
    .slice(0, 16),
);

console.log(`${SOURCE} → ${OUT}`);
console.log(`帧数 ${frames.length}`);
console.log(digests.join('\n'));
