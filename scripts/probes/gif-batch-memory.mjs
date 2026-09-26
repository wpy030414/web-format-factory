#!/usr/bin/env node
/**
 * 探针：把一整个目录的视频一口气转成 GIF，页面到哪里崩？
 *
 * 为什么要留着这个脚本：这个仓库的 GIF 编码路径是一台内存放大器——`modern-gif` 的
 * `Encoder` 在 `flush()` 之前持有每一帧的 RGBA（见 scripts/probes/gif-encoder-memory.mjs），
 * 而产物 blob 在 Chrome 下（`showDirectoryPicker` 存在 ⇒ 不启用暂存）会一路留在 store 里。
 * 两者叠加的结果不是「转得慢」，是「此网页已重新加载」——渲染进程被 OOM 掉，页面自己重启，
 * 什么错误都读不到。
 *
 * 光看代码推不出「第几个文件崩」，因为崩溃点取决于渲染进程的实时水位，而那个水位
 * 由并发槽位、帧尺寸、产物大小和 GC 时机共同决定。所以要真的跑起来、真的量。
 *
 * 量的方式：整棵浏览器进程树的 RSS（`ps`）。
 *   - `performance.memory.usedJSHeapSize` **不含** ArrayBuffer 的字节。实测：一次性分配
 *     320 MB 的类型化数组，它一动不动。而 GIF 编码的全部重量都在 ArrayBuffer 里。
 *   - `performance.measureUserAgentSpecificMemory()` 数得对，但它每次调用都会强制一次
 *     完整 GC——每秒量一次就是用测量行为本身把待测的崩溃掐灭。所以只在开头结尾各取一次。
 *   - `ps` 不干预被测进程，量的是真会被 OOM killer 看见的那个数。
 *
 * 用法：
 *   pnpm dev 起在 5173，然后
 *   node scripts/probes/gif-batch-memory.mjs [--dir <目录>] [--label <名字>] [--out <json>]
 *                                            [--browser webkit|chromium] [--only N] [--rounds N]
 *
 * 浏览器必须是 WebKit：Chromium 下这个批量跑得完、RSS 平坦（实测峰值 2.2 GB，无崩溃），
 * 因为它的内存上限和进程模型都宽得多。用户看到的那句「因为出现问题，此网页已重新加载。」
 * 是 WebKit 的说法，也是 WebKit 才会做的事——它按标签页的内存阈值直接杀掉 WebContent 进程。
 *
 * 换到 WebKit 还有一层含义：它没有 `showDirectoryPicker`，于是 `canSaveToFolder()` 为假，
 * App 会自动打开 IndexedDB 暂存（见 src/App.tsx）。也就是说 Safari 走的是**另一条**
 * 结果落地路径——每一个产物都要先写进 IDB 才会释放。这条路径正是最近三个提交动过的地方。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from '@playwright/test';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const DIR = argOf(
  '--dir',
  '/Users/xrl/Library/Mobile Documents/com~apple~CloudDocs/Downloads/deepseek_chan_by_NaiDrawBot-video-mp4',
);
const LABEL = argOf('--label', 'head');
const OUT = argOf('--out', `probe-gif-batch-${LABEL}.json`);
const BASE = argOf('--base', 'http://localhost:5173');
const BROWSER = argOf('--browser', 'webkit');
const ONLY = Number(argOf('--only', '0'));
const ROUNDS = Number(argOf('--rounds', '1'));
/** 批量卡片上要点的目标按钮。换一个目标就是换一条引擎路径，用来把「谁在留内存」分离开。 */
const TARGET = argOf('--target', 'GIF');
/**
 * 结果落地这条路的选择，用来把「谁在留内存」分离开。
 *
 *   idb（默认）   WebKit 里 `showDirectoryPicker` 不存在 ⇒ App 自动开 IndexedDB 暂存
 *   folder        塞一个假的目录选择器 ⇒ 走 FSAA 落盘那条路（不真写盘）
 *   none          同上但让 handle 为 null ⇒ 什么都不落地，产物留在 store 里
 */
const DRAIN = argOf('--drain', 'idb');
/** 采样间隔；换容器这类秒级任务要调小。 */
const INTERVAL_MS = Number(argOf('--interval', '1000'));
/** 批次结束后静置多久再采「残留」那一个数。 */
const SETTLE_MS = Number(argOf('--settle', '5000'));
/** 收尾时逼一次 GC，用来分辨「有人引用」与「没被回收」。 */
const GC_PROBE = args.includes('--gc-probe');
/** 收尾时把 WebContent 进程的内存构成 dump 下来。 */
const FOOTPRINT = args.includes('--footprint');

/**
 * 在一个 realm 里制造一次 GC 压力。
 *
 * 不是 `window.gc()`（WebKit 没暴露），而是喂 JSC 它一定会回收的东西：先堆一批短命对象
 * 把 eden 塞满，再要一块大 ArrayBuffer——「外部内存分配」是 JSC 判定该跑全量回收的信号之一。
 * 之后把引用全部丢掉，等它自己动手。如果内存是垃圾，这一步之后 RSS 会掉下来。
 */
async function provokeGc(target, label) {
  const dropped = await target.evaluate(async () => {
    let junk = [];
    for (let pass = 0; pass < 4; pass += 1) {
      for (let i = 0; i < 4000; i += 1) junk.push({ i, pad: new Array(64).fill(i) });
      junk = [];
      const big = new Uint8Array(96 * 1024 * 1024);
      big[0] = 1;
      await new Promise((r) => setTimeout(r, 60));
    }
    junk = null;
    await new Promise((r) => setTimeout(r, 200));
    return true;
  });
  console.log(`  逼 GC：${label} ${dropped ? '完成' : '未完成'}`);
}


const mb = (bytes) => (bytes === null || bytes === undefined ? null : Math.round(bytes / 1024 / 1024));

const files = readdirSync(DIR)
  .filter((n) => n.toLowerCase().endsWith('.mp4'))
  .sort()
  .slice(0, ONLY > 0 ? ONLY : undefined);
const payloads = files.map((name) => ({
  name,
  mimeType: 'video/mp4',
  buffer: readFileSync(join(DIR, name)),
}));

console.log(
  `${LABEL}：${payloads.length} 个文件 × ${ROUNDS} 轮，共 ${mb(payloads.reduce((s, p) => s + p.buffer.length, 0))} MB，${BROWSER}`,
);

const profileDir = mkdtempSync(join(tmpdir(), 'wff-probe-'));
const context =
  BROWSER === 'webkit'
    ? await webkit.launchPersistentContext(profileDir, { headless: false })
    : await chromium.launchPersistentContext(profileDir, { headless: false });
const page = context.pages()[0] ?? (await context.newPage());

if (DRAIN === 'none') {
  // 让 `canSaveToFolder()` 为真，App 就不会自动打开 IDB 暂存；用户没挑目录 ⇒ 不落地。
  await page.addInitScript(() => {
    window.showDirectoryPicker = () => Promise.reject(new Error('probe: 不挑目录'));
  });
} else if (DRAIN === 'folder') {
  // 落盘那条路：handle 是真的（有 write 方法），只是写到虚空里。
  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => ({
      async getFileHandle() {
        return {
          async createWritable() {
            return { async write() {}, async close() {} };
          },
        };
      },
    });
  });
}

/**
 * 浏览器整棵进程树的 RSS（KB）。
 *
 * 以 profile 目录认出主进程，再顺着 ppid 把 helper / GPU / 渲染进程 / worker 全部收进来。
 * 这就是「这个浏览器现在占了多大内存」——也正是不久之后会被 OOM killer 盯上的那个数。
 */
/**
 * 浏览器整棵进程树的 RSS（KB）。
 *
 * WebKit 的 WebContent / Networking / GPU 三个 XPC 进程会被 reparent 到 launchd（ppid=1），
 * 所以顺着 ppid 往下走是收不到它们的——而 WebContent 恰恰就是被内存阈值杀掉、
 * 再被浏览器重新加载的那一个。于是按安装目录认进程：一次只跑一个浏览器，不会认错。
 */
const installMarker = BROWSER === 'webkit' ? 'ms-playwright/webkit' : 'ms-playwright/chromium';
const browserPids = new Set();

function processRows() {
  const ps = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' });
  const rows = [];
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), args: m[4] });
  }
  return rows.filter((r) => r.args.includes(installMarker) || browserPids.has(r.pid));
}

function treeRssKb() {
  const rows = processRows();
  if (rows.length === 0) return null;
  for (const row of rows) browserPids.add(row.pid);
  return rows.reduce((sum, p) => sum + p.rss, 0);
}

/** 每个进程一行，用来看「到底是谁在涨」。 */
function breakdown() {
  return processRows()
    .map((p) => `${shortName(p.args)}:${mb(p.rss * 1024)}`)
    .join('  ');
}

/**
 * WebContent 的 phys_footprint（MB）。
 *
 * `ps` 的 RSS 把 clean / reclaimable 的共享页也算进去了，实测能高估一倍
 * （968 MB RSS vs 433 MB footprint）。而 WebKit 判自己该不该被杀、macOS 的 jetsam
 * 判该不该杀它，用的都是 footprint。所以「什么时候崩」这件事只能看 footprint。
 */
function webContentFootprintMb() {
  const webContent = processRows().find((p) => p.args.includes('WebContent'));
  if (!webContent) return null;
  try {
    const out = execFileSync('footprint', ['-p', String(webContent.pid)], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const match = /Footprint:\s*([\d.]+)\s*(MB|GB|KB)/.exec(out);
    if (!match) return null;
    const value = Number(match[1]);
    const unit = match[2];
    return Math.round(unit === 'GB' ? value * 1024 : unit === 'KB' ? value / 1024 : value);
  } catch {
    return null;
  }
}

function shortName(args) {
  const exe = args.split(' ')[0];
  return exe.split('/').pop().replace('.Development', '').replace('com.apple.WebKit.', '');
}

let crashed = false;
page.on('crash', () => {
  crashed = true;
  console.log('\n!!! 页面崩溃（renderer crash）——这就是「此网页已重新加载」');
});
page.on('pageerror', (error) => console.log('页面报错：', error.message));

await page.goto(BASE);
await page.getByRole('heading', { name: 'Web Format Factory' }).waitFor();

const baselineKb = treeRssKb();
console.log(`基线 RSS：${mb((baselineKb ?? 0) * 1024)} MB`);
console.log(breakdown());

const samples = [];

/** 每一轮：拖入 → 批量选 GIF → 全部转换 → 等完成或崩溃。 */
for (let round = 1; round <= ROUNDS && !crashed; round += 1) {
  if (round > 1) {
    // 清掉上一轮已经完成的卡片，否则「开始转换」找不到可做的工作。
    await page.getByRole('button', { name: /全部下载|清除/ }).first().press('Escape').catch(() => undefined);
    await page.evaluate(() => {
      for (const button of document.querySelectorAll('button[aria-label^="移除 "]')) {
        button.click();
      }
    });
    await page.waitForTimeout(500);
  }

  await page.setInputFiles('input[type=file]', payloads);
  await page
    .locator('[data-testid="media-class"]')
    .nth(payloads.length - 1)
    .waitFor({ timeout: 180_000 });
  console.log(`第 ${round} 轮：识别完成`);

  if (round === 1) {
    await page.getByTestId('batch-switch').click();
    await page.locator('[data-testid="batch-card"]').waitFor();
    await page
      .locator('[data-testid="batch-card"]')
      .getByRole('button', { name: TARGET, exact: true })
      .click();

    if (DRAIN === 'folder') {
      await page.getByRole('button', { name: /选择保存目录/ }).click();
      await page.getByText('已选保存目录').waitFor({ timeout: 10_000 });
    }
  }

  const startButton = page.getByRole('button', { name: /开始转换/ });
  console.log(`第 ${round} 轮：`, await startButton.textContent());

  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      const done = await page.getByTestId('download-result').count().catch(() => -1);
      const rss = mb((treeRssKb() ?? 0) * 1024);
      const fp = webContentFootprintMb();
      const perProcess = breakdown();
      samples.push({ round, t: Date.now(), done, rssMb: rss, footprintMb: fp, perProcess });
      console.log(
        `  第 ${round} 轮 完成 ${String(done).padStart(3)}/${payloads.length}   WebContent footprint ${String(fp).padStart(5)} MB   ${perProcess}`,
      );
      if (crashed || done === payloads.length) break;
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  })();

  await startButton.click();
  await Promise.race([
    page
      .locator('[data-testid="download-result"]')
      .nth(payloads.length - 1)
      .waitFor({ timeout: 900_000 })
      .then(() => console.log('  全部完成'))
      .catch((error) => console.log('  等待提前结束：', String(error).split('\n')[0])),
    new Promise((r) => page.on('crash', r)),
  ]);
  stop = true;
  await sampler;

  // 页面是不是被重载了？列表被清空而文件是刚拖进去的，只有这一个解释。
  const stillListed = await page.locator('[data-testid="media-class"]').count().catch(() => -1);
  const reloaded = stillListed === 0;
  if (reloaded) {
    crashed = true;
    console.log('\n!!! 页面已被重载（列表清空）——这就是「此网页因为出现问题已重新加载」');
  }

  // 静置一下再采一次。秒级就能跑完的活儿（换容器）采样器根本来不及看，
  // 而「做完之后留下多少」恰恰是唯一重要的那个数。
  await page.waitForTimeout(SETTLE_MS);
  const settled = mb((treeRssKb() ?? 0) * 1024);
  const settledPerProcess = breakdown();
  samples.push({ round, t: Date.now(), done: payloads.length, rssMb: settled, perProcess: settledPerProcess, settled: true });
  console.log(`  第 ${round} 轮 静置 ${SETTLE_MS / 1000}s 后   合计 ${String(settled).padStart(5)} MB   ${settledPerProcess}`);

  // 那一大坨内存到底是「还有人引用」还是「已经是垃圾、只是没人回收」？
  // 逼一次 GC 就知道：JSC 不会为一个对象数很少的堆主动跑全量回收，
  // 所以「释放引用」和「内存还回来」之间可能隔着好几个 GB。
  if (GC_PROBE && !crashed) {
    await provokeGc(page, '主线程');
    const worker = page.workers()[0];
    if (worker) await provokeGc(worker, 'worker');
    await page.waitForTimeout(SETTLE_MS);
    const after = mb((treeRssKb() ?? 0) * 1024);
    console.log(`  逼 GC 之后   合计 ${String(after).padStart(5)} MB   ${breakdown()}`);
    samples.push({ round, t: Date.now(), done: payloads.length, rssMb: after, perProcess: breakdown(), afterGc: true });
  }

  // 把那坨内存切开看是什么：IOSurface？WebKit Malloc？JS 堆？
  // RSS 只告诉你「涨了」，`footprint` 才告诉你「涨的是什么」。
  if (FOOTPRINT && !crashed) {
    const webContent = processRows().find((p) => p.args.includes('WebContent'));
    if (webContent) {
      const dump = execFileSync('footprint', ['-p', String(webContent.pid)], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      writeFileSync(`${OUT}.footprint.txt`, dump);
      const summary = dump
        .split('\n')
        .filter((l) => /MB|GB|Total|Auxiliary|Dirty|Swapped|\d{2,}\s+[KM]B/.test(l))
        .slice(0, 40)
        .join('\n');
      console.log(`  footprint（WebContent pid ${webContent.pid}）：\n${summary}`);
    }
  }

  if (!crashed) console.log(`第 ${round} 轮完成：${samples.at(-1)?.done ?? 0}/${payloads.length}`);
}

const finished = samples.at(-1)?.done ?? 0;
const peakRss = Math.max(...samples.map((s) => s.rssMb ?? 0));

console.log('\n收尾时各进程：');
console.log(breakdown());

console.log(
  [
    '',
    `结论（${LABEL}）：`,
    `  - 崩溃：${crashed ? '是' : '否'}`,
    `  - 最后一轮完成：${finished}/${payloads.length}`,
    `  - 浏览器 RSS 峰值：${peakRss} MB（基线 ${mb((baselineKb ?? 0) * 1024)} MB）`,
  ].join('\n'),
);

writeFileSync(
  OUT,
  JSON.stringify(
    {
      label: LABEL,
      browser: BROWSER,
      crashed,
      rounds: ROUNDS,
      finished,
      total: payloads.length,
      peakRss,
      samples,
    },
    null,
    2,
  ),
);
console.log(`采样写入 ${OUT}`);

await context.close();
