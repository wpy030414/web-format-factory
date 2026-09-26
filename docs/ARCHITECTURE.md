# ARCHITECTURE — Web Format Factory

## 系统概述

整体结构是**三层引擎 + 一张静态路由表**。没有服务端。

```
┌──────────────────────────────────────────────────────────────────────┐
│  主线程                                                                │
│    React 19 UI  ·  Zustand store  ·  JobScheduler（纯 TS，非 React）    │
│    CapabilityRegistry（isConfigSupported 探测结果缓存）                 │
└───────────────┬──────────────────────────────────────────────────────┘
                │ postMessage（File/Blob 近乎零成本；ArrayBuffer 转移所有权）
┌───────────────▼──────────────────────────────────────────────────────┐
│  Workers                                                              │
│    probe.worker       × 1   魔数嗅探 + 容器解析 + 配对识别               │
│    media.worker       × 1   Mediabunny + WebCodecs                   │
│    image.worker       × 2–4 Canvas / ImageDecoder / OffscreenCanvas   │
│    kernel.worker      × 2   各 WASM 内核（与内核族亲和绑定）             │
│    ffmpeg 内部 worker  × 1   + core-mt 的 pthread 池                   │
└──────────────────────────────────────────────────────────────────────┘
```

**引擎分层**（按代价从低到高，只在前一层覆盖不到时才付下一层的代价）：

| 层 | 引擎 | 体积 | 负责 |
| --- | --- | --- | --- |
| A | **Mediabunny**（WebCodecs） | ~70 KB | 全部影音容器与编码：MP4/MOV/MKV/WebM/M4A/MP3/WAV/ADTS/FLAC/OGG |
| B | **图像与动图栈** | 按需 | JPEG/PNG/WebP、GIF、APNG、HEIC 解码——Mediabunny 完全不含图片 |
| C | **ffmpeg.wasm** | 31.2 MB | 仅限白名单：动态 WebP 编码、真 Vorbis 编码、Apple Live Photo 打标 |

选 A 作主干而非 ffmpeg.wasm 是「高性能优先」的直接结果：ffmpeg.wasm 比原生慢 10–30 倍且无硬件加速，
而 Mediabunny 走 WebCodecs 硬件编解码，且**默认行为就是「能复用就复用」**——恰好对应无损换容器。
用户最常用的路径（影音互转、视频转音频、GIF 出入）全部落在 A + B，即全部走硬件加速。

## 核心模块

| 模块 | 职责 |
| --- | --- |
| `src/core/types.ts` | 全局共享词汇：媒体类别、容器、编码、转换类别、保真度 |
| `src/core/codecs.ts` | 编码词汇表的唯一出处：id、浏览器认识的那个字符串、显示名 |
| `src/core/registry/` | 格式注册表与「范围白名单」，产品边界的唯一收口点 |
| `src/core/routing/` | 类别跃迁表、判定与归因文案、能力闸门 |
| `src/core/loss/` | 损失码、严重度、保真度计算 |
| `src/engines/` | 四个引擎适配器，按需动态加载 |
| `src/livephoto/` | Live Photo 的识别、拆包、封装（Apple / Google） |
| `src/workers/` | Worker 入口 |
| `src/ui/` | React 组件 |

## 模块关系

`core/` 是**纯逻辑，不依赖任何引擎**，因此可被完整单测。引擎层只被 `core` 的判定结果驱动，
`core` 不认识任何具体引擎——它产出「执行计划」，由引擎层负责执行。

唯一读浏览器的地方是**能力探测**（`caps.ts` 的实测，以及 `gates.ts` 里那几个同步读取）。
它读的是「这台机器有没有这个 API」，而不是「某个引擎怎么用这个 API」；这条界线让路由层
可以在 node 里被完整测试，也让引擎整个换掉而不动判定。

这条分界是刻意的：**路由知识全部是数据，引擎知识全部是命令式代码**。

## 数据流

```
File
 └─ 魔数嗅探（不信扩展名）──> 媒体类别 + 容器细节
      └─ 容器解析 ──> MediaProfile（轨道、编码、时长、alpha、HDR、方向、元数据）
           └─ 类别判定 ──> 可达目标集合
                └─ 用户选择目标 + 参数
                     └─ 路由解析 ──> ResolvedPlan
                          ├─ 策略（transmux 优先于 transcode）
                          ├─ 能力闸门求值（COI / ImageDecoder / 源解码 / 目标编码）
                          └─ 损失标注 + 保真度
                               └─ 执行（Worker 派发 + 进度 + 可取消）
                                    └─ 结果报告（对产物再探测一次，输出前后差异）
```

## 外部系统

无。这是设计目标而非疏漏：**运行时没有网络请求**（WASM 引擎的自托管资源除外，且可被 PWA 缓存）。
部署环境需要下发 COOP/COEP 响应头，见 `deploy/`。

## 重要技术边界

- **COOP/COEP**：只有 C 层（ffmpeg 多线程核心）需要跨源隔离。A、B 两层不需要。
  因此即使响应头缺失，产品仍然可用，只是失去兜底引擎——**降级而不是失败**。
  另需注意：缺响应头时 ffmpeg 的 `load()` 会**静默挂起**，所以启动时必须主动检测
  `crossOriginIsolated`。
- **内存**：ffmpeg.wasm 是 32 位，约 2 GB 上限；其多线程核心还会预留固定 1 GB 堆且不可增长。
  大文件必须用 `WORKERFS` 挂载，避免把整个文件复制进堆。
- **`VideoFrame` / `ImageBitmap` 泄漏**是 WebCodecs 应用标签页崩溃的头号成因，必须在
  `finally` 中逐个关闭。
- **`canvas.toBlob()` 会静默抹掉全部 EXIF / XMP / ICC**，且 `drawImage()` 忽略 EXIF 方向。
  图像路径必须经统一的 `normalizeOrientation()` 出口。
- **`AudioContext.decodeAudioData()` 会重采样到上下文采样率**，对纯格式转换是错的，
  已被 ESLint 规则禁用。

详细的引擎选路规则与各格式的损失语义见 `docs/specs/`。
