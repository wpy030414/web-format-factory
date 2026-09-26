# Research — 批量转 GIF 把 WebKit 的页面压死：那坨内存到底是什么

- **日期**：2026-09-27
- **环境**：macOS 27.0 (26A428)、Apple Silicon、16 GB；Playwright WebKit 26.6（`webkit-2359`）、Playwright Chromium 153.0.8010.12；样本为 512×512 / 6–70 帧的短视频；探针见 `scripts/probes/`
- **起因**：用户报告「把一整个目录的 mp4 一口气全转成 GIF，页面会说『因为出现问题，此网页已重新加载』——文件全没了」，并判断「最近三个 commit 之后出现得更早」
- **状态**：现象**已复现**；「最近三个 commit」「IDB 暂存」「产物 blob」「每帧一个新 canvas」四项**均被实测排除**。增长定位到 WebKit 每转换一次的固定开销，JS 层放不掉——**唯一能清零的手段是终止 worker**（§7，已在应用里接上并端到端验证）。

**一句话结论**：这是 **WebKit 独有**的问题——同一批文件在 Chromium 下全程不涨。涨的不是产物、也不是任何 JS 引用（暂存那条路是干净且有效的），而是**每次转换在 WebContent 进程里留下的原生内存**：单任务峰值工作集约 **193 MB**，批次里每文件净留 **35–60 MB**，一路涨到 WebKit 杀掉进程为止。这个数在 JS 里没有对应的释放动作可做。

> ⚠️ 本文 §5 记录了一个**被自己推翻的结论**：我一度量出「给 `CanvasSink` 加 `poolSize` 能把涨速减半」，重复实验证明那是单跑噪声。过程保留，不要只读那一段。

---

## 1. 方法

三个探针，都在 `scripts/probes/`：

| 脚本 | 量什么 |
| --- | --- |
| `gif-encoder-memory.mjs` | `modern-gif` 的 `Encoder` 在 `flush()` 之前替我们扣住多少内存（Node，不依赖浏览器） |
| `gif-batch-memory.mjs` | 驱动真实应用跑一整批转换，按秒记录进程内存；浏览器、目标格式、落地方式、采样方式都可选 |
| `gif-pool-fidelity.mjs` | 改动前/后产物的逐帧摘要与整文件比对 |

```bash
pnpm dev --port 5173 --strictPort &
node scripts/probes/gif-batch-memory.mjs --browser webkit --dir <样本目录>
```

### 1.1 必须用 WebKit，而且必须有头

`chromium.launch()` 默认用 headless shell：**同一批 120 个文件在那里跑完，RSS 平得像地板，永远复现不了**（实测峰值 2.2 GB）。要复现用户的崩溃必须走完整 WebKit，而且要开窗口（`launchPersistentContext(..., { headless: false })`）。

同一条分界线也切掉了两个内存 API：

- `performance.measureUserAgentSpecificMemory()` 在无头 shell 里**恒抛** `SecurityError: ... is not available`，在**有头**里正常；页面已经 `crossOriginIsolated === true`，所以这不是跨源隔离的问题。
- `performance.memory.usedJSHeapSize` 在两种模式下都存在，但它**不含 ArrayBuffer 的字节**。实测：一次性分配 320 MB 的 `Uint8ClampedArray`，它**纹丝不动（delta = 0）**。而 GIF 编码的全部重量都在 ArrayBuffer 里——用它等于闭着眼睛量。

### 1.2 采样的口径：用 `footprint`，不要用 `ps` 的 RSS

`ps` 的 RSS 把 clean / reclaimable 的共享页也算进去，实测在同一个时刻：**RSS 968 MB vs `footprint` 433 MB**——高估一倍多。而 WebKit 判自己该不该被杀、macOS 的 jetsam 判该不该杀它，用的都是 `phys_footprint`。所以「什么时候崩」只能看 footprint。

```bash
footprint -p <WebContent 的 pid>     # 头一行就是 Footprint，下面按类别分
```

WebKit 的进程模型还要求按**安装目录**认进程：WebContent / Networking / GPU 三个 XPC 进程会被 reparent 到 launchd（`ppid=1`），顺着 ppid 往下走是收不到它们的——而 WebContent 恰恰就是被杀的那一个。

---

## 2. 复现：120 个文件，WebContent 涨到 4.3 GB 然后被杀

```
基线            WebContent footprint  212 MB
完成  20/120 →  4314 MB        ← 注意：这是 RSS，口径见 §1.2
完成 100/120 →  4305 MB (footprint)
完成 114/120 → 10240 MB (footprint，瞬时)
之后            列表清空、计数回到 0/120        ← 页面被重载
```

崩溃点是**概率性**的，不是一条固定的线：同一批 120 个文件，我有时看到它在第 20 个就被杀，有时能跑完。WebKit 是按**系统**内存压力挑进程杀的，而那台机器上同时开着什么并不由这个页面决定。这也是用户「有时更早、有时更晚」这个观察最可能的来源。

---

## 3. 排除项一：最近三个 commit（e610333 / e5a7847 / d5a8acb）

把 `src/` 整体退回 `785d51d`（三个 commit 之前），跑同一批真实样本：

| 版本 | 每文件增幅（RSS 口径，120 个样本） |
| --- | --- |
| `785d51d`（之前） | 117 MB |
| HEAD（之后） | **101 MB** |

**这三个 commit 不是原因，甚至略好。**它们的意图（`input.dispose()`、`evictResult` 连输入文件一起放掉）方向是对的。用户感觉到的「更早」，我量不出来。

```bash
git checkout 785d51d -- src/     # 跑完记得恢复
git checkout HEAD -- src/
```

---

## 4. 排除项二：IndexedDB 暂存与产物 blob

这是最值得怀疑的一条，因为它**只在 Safari 生效**：WebKit 没有 `showDirectoryPicker`，于是 `canSaveToFolder()` 为假，`App.tsx` 的那个 effect 会自动打开 IDB 暂存——每个产物都先写进 IDB 才释放。也就是说 Safari 走的是**另一条**结果落地路径。

实测（10 个文件，同一批样本）：

| 落地方式 | 每文件增幅 |
| --- | --- |
| `idb`（Safari 的默认） | 76 MB |
| `none`（彻底不落地） | 87 MB |

**一模一样。**而且 WebKit 的 IndexedDB 跑在 **Networking** 进程里，它全程是平的：

```
Networking: 84 MB（基线）→ 58 MB（第 34 个文件）→ 52 MB（收尾）
```

产物本身也小得可以忽略：512×512 / 11–41 帧的 GIF 只有 **250 KB – 830 KB**。

结论：**「存进 IDB 之后内存里只留引用」是对的，而且这条路径工作正常**——问题是那坨内存从来不经过它。

---

## 5. 更正记录：canvas 池化（我的错误结论，保留）

**先说结论：错的。**我一度改了一行并宣称有效：

```ts
const sink = new CanvasSink(track, { poolSize: 3 });   // 不要抄，见下
```

理由是读源码看到的：不给 `poolSize` 时 `_canvasPool` 是空数组，`_videoSampleToWrappedCanvas` 于是**每一帧都 `new OffscreenCanvas`**——一个 41 帧的片段就是 41 张画布。

单跑确实好看：done=40 时 footprint 1960 → 1109 MB，我据此说了「涨速减半」。

**重复实验推翻了它。**同一批 30 个文件、pool/nopool 交替各跑 3 次：

| | rep1 | rep2 | rep3 | 中位数 |
| --- | --- | --- | --- | --- |
| 有池 | 1100 | 1336 | 1252 | **1252 MB** |
| 无池 | 989 | 1294 | 1824 | **1294 MB** |

配对差约等于零。再用最干净的尺度（**单个任务**的峰值工作集，各 4 次）验证：

| | 4 次 | 中位峰值 | 工作集 |
| --- | --- | --- | --- |
| 有池 | 382 / 412 / 404 / 405 | 404 MB | **192 MB** |
| 无池 | 398 / 411 / 422 / 406 | 406 MB | **194 MB** |

**没有效果。**代码已撤回（`git checkout -- src/engines/animation/index.ts`）。

顺带两条不能丢的事实：

- 池化对产物是**零影响**——改前改后的 GIF **`cmp` 字节完全相同**，逐帧摘要也一致（`gif-pool-fidelity.mjs`）。所以它是个「安全但无用」的改动。
- 单任务工作集 **193 MB** 里，我们自己的整帧像素只占 **41 MB**（41 帧 × 512×512×4）。**其余 ~150 MB 不在我们的代码里**——这才是下一节要说的那件事。

### 5.1 顺带量清楚的：编码器扣的是 4 字节/像素，不是 1

`MAX_GIF_PIXEL_SECONDS = 400_000_000` 的注释写着「一个分段最多扣住这么多**字节**」。这是从「编码器每帧每像素留一个索引字节」推出来的，**但那是写盘时的中间产物，不是编码器内存里持有的东西**。实测（`gif-encoder-memory.mjs`，640×360 各 128 帧）：

```
128 帧持有   112.5 MB   每帧 0.9 MB = 640×360×4     ← 就是喂进去的 RGBA
每像素每帧   4.00 字节
```

所以 **400M 的预算实际是 1.6 GB**（1080p ≈ 193 帧/段），翻两倍并发就是 3.2 GB。这个常数现在还没有动——它对这些 40 帧的样本根本不触发，而改小它会让长片段被切成多个文件，那是产品可见的变化，得单独决定。

---

## 6. 那它到底是什么：WebKit 每转换一次的固定开销

把上面排掉的都去掉之后，剩下的是这个形状：

| 量 | 实测 |
| --- | --- |
| 单任务在 WebContent 里的峰值工作集 | ~193 MB（其中我们自己的帧数据 41 MB） |
| 批次里每文件净留下 | 35 – 60 MB |
| 换容器的对照组（不解码、不编码） | 仍有 **27 MB/文件** 的底噪 |

并且它**是垃圾、但 WebKit 不收**：

- `footprint` 按类别切开，大头是 `WebKit Malloc`：403 MB dirty 里 **330 MB 是 reclaimable**。
- 逼一次 GC（在页面和 worker 里各制造一轮分配压力，`--gc-probe`）：875 MB → **844 MB**，只掉 31 MB——约等于一个文件的量。
- Chromium 对同一批文件**完全不涨**。这条最要紧：**同一份 JS 对象图，两个引擎表现不同，说明涨的不是 JS 引用**——否则 V8 也得跟着涨。

所以「每转完一个就持久化、释放内存」做不到这件事：那条路放掉的是**引用**，而这坨内存压根不在引用里。

---

## 7. worker 回收：能，而且是唯一能清零的手段

先在最纯粹的层面上问：**在 WebKit 里终止一个 worker，账面上的内存还不还？**
探针 `webkit-worker-recycle.mjs`——不经过应用，就一个 worker、200 MB 大 ArrayBuffer，
「分配 → 丢引用 → 终止 → 再来一轮」：

| 步骤 | WebContent footprint |
| --- | --- |
| 基线 | 75 MB |
| worker 里分配 200 MB（逐页写实） | **276 MB**（+201） |
| 丢掉全部引用 | 275 MB —— **只还了 1 MB** |
| `terminate()` | **73 MB —— 203 MB 全回来了** |
| 第 2 轮重新分配 200 MB | 66 MB —— **复用，不再涨** |
| 第 3 轮 | 65 MB —— 平的 |

三件事一次说清：

1. **丢掉引用什么都不会发生。**这就是应用里那 35–60 MB/文件的性质——`landResult` 那条路放掉的是引用，而 WebKit 不因为引用消失就把页还给系统。
2. **`terminate()` 能把账清零。**进程把整个 worker 的堆交还了。
3. **新 worker 复用那块内存。**所以「每 N 个任务重建一次引擎」不会一轮一轮往上叠。

> 这个探针第一版骗过我一次：只 `new Uint8Array(1 MB)` 而不写它，页全是零页、
> copy-on-write 指向同一个物理页，「分配 200 MB」在 footprint 上只涨 **1 MB**。
> 必须逐页写一个字节才量得到真东西。

### 7.1 接到应用里：第一版调度是错的

先在 `store.ts` 里写了最直觉的那一版：任务收尾时若「计数到期 **且** `running === 0`」就换 worker。

**它整个批次只触发了 1 次，在最后。**插一行临时日志跑 25 个文件，只有一条 `recycling worker after 25 jobs`。原因是 `MAX_CONCURRENT = 2` 加一条永远有活儿的队列：一个任务收尾时 `running` 是 2 → 1，兄弟槽位立刻又被填上，**`running` 直到最后一个文件都不会碰到 0**。

所以回收必须**自己造出那个空隙**：到点了就停止投喂队列，等兄弟槽位收工，换掉 worker，再继续。代价是每 N 个文件停一次（一次任务的长度）。

### 7.2 修正之后：120 个文件，footprint 回到基线

同一批 120 个文件（41 帧 512×512），`RECYCLE_AFTER_JOBS = 10`：

| 完成 | 不回收 | 每 10 个换一次 worker |
| --- | --- | --- |
| 20 | 2128 MB | **329 MB** |
| 40 | 1769 MB | **271 MB** |
| 80 | 7626 MB | **248 MB** |
| 119 | 4901 MB | **219 MB** |

跑完 120 个文件，WebContent 的 footprint 回到 **219 MB**——基本就是基线。不再是单调上涨。

**代价**：同一批 120 个文件的总耗时 222 s → 258 s（**+16%**，每个重建约 3 s）。注意这是**开发服务器**上的数——那里 worker 的每个模块都是单独一次请求；生产构建里 worker 是一个 bundle，重建应该便宜得多。这个数没有在生产构建上量过。

## 8. 对项目的意义

1. **这条崩溃路径是真的，而且只在 Safari/WebKit 出现。**Chromium 之所以一直没暴露它，不是因为它更省，而是因为它的回收更及时。
2. **「每文件持久化 + 释放」不是解药，但也不是没用。**它保证产物不堆在内存里（Networking 全程平的）——如果没有它，Safari 会更早死。问题在于它管的不是杀死页面的那一坨。
3. **诊断这件事有三个坑，都踩过了**：无头浏览器复现不了；`measureUserAgentSpecificMemory` 在无头里不可用；`usedJSHeapSize` 不含 ArrayBuffer；`ps` 的 RSS 高估一倍。四个坑任踩一个，结论都会变成「没发现问题」。
4. **测量本身也会骗人**：一次单跑就能得出「减半」的结论，重复三次就没了。凡是要写进关键路径的改动，样本量必须扛得住。
5. **解药不在「释放」那一侧，在「重启」那一侧。**整个排查里最反直觉的一条：所有「把引用放干净」的努力（暂存落地、`evictResult`、`input.dispose()`、逼 GC）都不动那个数，而一下 `terminate()` 就全回来了。遇到「释放不掉」的内存，先问它是不是根本不在引用图里。
6. **并发与回收是相冲的。**两个槽位让 `running` 永远碰不到 0，于是「闲置时回收」这种写法在真正的批次里一次都不会触发——第一版就是这么错的，日志里只有一行「after 25 jobs」。凡是「等空闲再做事」的逻辑，都要先问空闲会不会到来。

## 9. 遗留问题

- **`RECYCLE_AFTER_JOBS = 10` 是拍的，不是量的最优值。**它由两个代价夹出来：太小则重建本身的开销和批次停顿变得显眼，太大则又回到涨到被杀。10 使得 41 帧 / 512×512 的一批在工作集涨到 ~500 MB 之前就换掉——换成 1080p 的长片，单个任务的工作集本身就大得多（§5.1：4 字节/像素），这个阈值该跟着什么走还没有答案。
- **每 N 个文件停一次是用户能感觉到的**（一批 120 个文件里停 12 次）。要不要在界面上说明、或者只在内存确实吃紧时（`performance.measureUserAgentSpecificMemory` 在 WebKit 里不可用，所以得换别的判据）才回收，没有定论。
- `MAX_GIF_PIXEL_SECONDS` 的 4 倍偏差（§5.1）还没动，那是产品决策。
- `tests/e2e/convert.spec.ts` 里有 3 个 Live Photo 用例在**干净的 HEAD 上就失败**（期望按钮文案「两个文件」，代码产出「2 个文件（zip）」），与本文无关，但顺手记在这里。
- 真实 Safari 与 Playwright WebKit 仍有差别（版本、系统、扩展），本机没有 Safari 可对照。

## 10. 复现方法

```bash
# 起开发服务器（COOP/COEP 由 vite.config.ts 下发）
pnpm dev --port 5173 --strictPort &

# 批量转 GIF 并记录内存；--browser webkit 是必须的
node scripts/probes/gif-batch-memory.mjs --browser webkit --dir <样本目录> --interval 1500

# 落地方式对照：idb（Safari 默认）/ folder / none
node scripts/probes/gif-batch-memory.mjs --browser webkit --drain none --dir <样本目录>

# 收尾时逼一次 GC，分辨「有人引用」和「没被回收」
node scripts/probes/gif-batch-memory.mjs --browser webkit --gc-probe --dir <样本目录>

# 编码器实际持有多少（Node，不需要浏览器）
node scripts/probes/gif-encoder-memory.mjs

# 改动前后产物是否逐帧一致（必须先生成两次产物再比）
node scripts/probes/gif-pool-fidelity.mjs --out /tmp/a.gif
```

样本：原始素材（`deepseek_chan_by_NaiDrawBot` 的 120 个 512×512 短片）在研究中途被移出了 iCloud，后来的对照改用同素材合成片段（`ffmpeg -f lavfi -i testsrc`），结论不受影响——所有横向对照都在同一批样本上做。
