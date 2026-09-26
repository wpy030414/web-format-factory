# Spec — 引擎选路

## 要构建什么

给定一个探测结果与一个目标格式，解析出**具体由哪个引擎、以何种策略执行**，
并给出该策略的能力闸门、代价估计与损失标注。

## 输入 / 输出

- **输入**：`MediaProfile`（探测结果）、目标 `FormatId`、用户参数、当前引擎能力
- **输出**：`ResolvedPlan` 或 `Unresolvable`

`ResolvedPlan` 包含：

- 选中的策略与**候选策略列表**（按代价升序）
- 能力闸门求值结果
- `degraded` 标志——首选策略未通过闸门时为真，需用户确认，**绝不静默降级**
- 损失项与保真度
- 体积估算

## 引擎分层

| 层 | 引擎 | 体积 | 何时使用 |
| --- | --- | --- | --- |
| A | Mediabunny（WebCodecs） | ~70 KB | 全部影音容器与编码 |
| B | 图像与动图栈 | 按需 130 KB–5.8 MB | 图片与动图——Mediabunny 完全不含 |
| C | ffmpeg.wasm | 31.2 MB | 仅限下方白名单 |

## 一条路由 = 一串候选策略

同一个格式对内部，transmux 与 transcode 是**选择**而非固定属性。
`MOV → MP4`（H.264/AAC）既有「瞬时无损保编码」，也有「慢且有损但可换编码、可调质量」。
参数负责在候选间筛选；无法满足所需参数的策略被**剔除**，而不是忽略该参数。

## ffmpeg 例外白名单（用 lint 锁死）

只有下列组合允许在策略中出现 `ffmpeg`：

1. **动态 WebP 编码**——无维护中的 JS/WASM 实现
2. **真 Vorbis 编码**——主干引擎只有解码器
3. **Apple Live Photo 的 MOV 打标**——见 `docs/DECISIONS.md` ADR-004
4. 其余全部引擎均无法解码该源编码时
5. AV1 编码——**待验证**：stock 核心未编译 aom，此条可能一出生就是死的。
   上线前必须用 `ffmpeg -encoders | grep av1` 在真实核心里确认。若不存在，
   **删除该路由**并以 `no-encoder-in-browser` 标记为不可能，提供 VP9/WebM 作为替代。
   绝不保留一条注定失败的路由。

**据此，ffmpeg 在约 225 个格式对中只应可达 8–12 个。其余通往 ffmpeg 的路径都是 bug。**

## 能力闸门

| 闸门 | 检查什么 |
| --- | --- |
| `coi` | `crossOriginIsolated`（仅 ffmpeg 多线程核心需要） |
| `webcodecs-encode` / `webcodecs-decode` | 目标编码器/解码器可用性 |
| `image-decoder` | `ImageDecoder` 是否存在 |
| `create-image-bitmap-heic` | Safari 的 HEIC 原生解码快路径 |
| `kernel-loaded` | 所需 WASM 内核是否已加载 |

**探测一律用真实的宽高/码率/帧率**调 `isConfigSupported()`——只探 codec 字符串会误判。
H.264 的 profile/level 串需**由高到低逐级回退**。`prefer-hardware` 只能当「尝试」而非保证：
拿不到硬件时会静默落到软件路径，而 `isConfigSupported` **不会告诉你这件事**。
探测结果按 `codec:sampleRate:channels` 缓存。

## 平台能力（必须显式建模，否则静默失败）

| 平台 | 限制 |
| --- | --- |
| **Safari < 26** | `AudioEncoder` / `AudioDecoder` / `ImageDecoder` 完全不存在（视频类有） |
| **Firefox Android** | 任何版本都没有 WebCodecs |
| **Chrome Android** | `VideoEncoder` 直到 147+ 才可用 |
| Firefox 桌面 / 桌面 Linux | **AAC 编码缺失** |
| 全平台 | **MP3 / FLAC 编码 WebCodecs 永远没有**；Vorbis 编码约 3.8% |

WebCodecs 缺失时的降级次序：`ImageDecoder` → JS 兜底解码器 → 兜底引擎。

## 代价模型

每条策略声明 `relativeSpeed`、是否 I/O 受限、以及随什么规模增长（字节/帧/像素/时长）。
用于：

- UI 上的速度徽章（瞬时 / 快 / 慢 / 很慢——需下载 31MB 引擎）
- 候选策略排序
- 转换前的体积与耗时预估

## 约束

- **不做图搜索**，见 `docs/DECISIONS.md` ADR-002。
- 首选策略未通过闸门时，返回**次优且明确标注降级**的计划，需用户确认。
- **绝不静默替换为更有损的编码。**
- 编译期为每个策略从**允许清单**构造 `ConversionOptions`，不做用户参数的展开——
  这是为了挡住两个已知陷阱（见下）。

## 两个必须挡住的陷阱

1. **Mediabunny 的 `alpha` 默认是 `'discard'`**——带 alpha 的 WebM 转 WebM 会无声丢失透明通道。
   带 alpha 的策略必须显式设 `alpha: 'keep'`。
2. **`keyFrameInterval` 默认 5 秒且会强制转码**——在 transmux 路由上误传它，
   会把一个瞬时无损任务悄悄变成慢速有损任务。该参数只在 transcode 策略中可见。

## 验收标准

- [ ] 全部格式对的解析不抛异常，且被快照测试锁定
- [ ] 通往 ffmpeg 的策略仅出现在白名单组合中（lint 规则）
- [ ] `alpha` 陷阱与 `keyFrameInterval` 陷阱各有回归测试
- [ ] 闸门失败时返回 `degraded: true` 而非静默降级
- [ ] 探测结果按 `codec:sampleRate:channels` 正确缓存

## 完成定义

`resolve()` 对全部格式对返回确定结果；白名单外无 ffmpeg 路径；两个陷阱有回归测试守护。
