# Spec — Live Photo

## 要构建什么

Live Photo 的识别、拆包与**重新封装**（双向）。Live Photo 是全项目唯一
「不是一个文件、而是一个文件包」的格式，因此需要独立于常规转换管线的处理。

支持两种互不兼容的形态：Apple 与 Google。

## 两种形态

### Apple Live Photo

一张静图（HEIC 或 JPEG）+ 一段约 3 秒的 MOV，两者共享一个 **content identifier**。

- 标识在 MOV 内以 QuickTime 元数据键 `com.apple.quicktime.content.identifier` 存在，
  位于 `moov/meta` 的 `keys` + `ilst` 结构中。
- Apple 还会写入一条 `com.apple.quicktime.still-image-time` **定时元数据轨道**，
  标记视频中哪一帧对应静图。
- `.livp` 就是一个 ZIP，内含 `<name>.heic`（或 `.jpg`）与 `<name>.mov`。

### Google Motion Photo

**单文件**：一张 JPEG（或 HEIC/AVIF），尾部拼接 MP4。

- XMP 命名空间为 `http://ns.google.com/photos/1.0/camera/`，前缀 **`Camera:`**
  （旧资料中的 `GCamera:` 是过时前缀）。
- 关键性质：**`Camera:MicroVideoOffset` 从文件末尾起算**，因此它**恰好等于视频的字节长度**。
  这比「先算长度再回填」简单——可以在不知道最终文件大小的情况下先行写入。
- 现代实现还用 `Container:Directory` + `Item:Semantic="MotionPhoto"`（必须是最后一项）
  + `Item:Length`；HEIC/AVIF 变体要求 `Item:Padding = 8`（`mpvd` 盒头长度）。**两套都要写。**
- 旧版 `MicroVideo*` 系列键（V1）若存在**应当忽略**。
- 文件名通常以 `MP` / `MP.jpg` 结尾。

## 行为

### 识别

1. `PK\x03\x04` → 解压 → 恰好一张图 + 一个 `.mov` → `apple-livp`。
2. JPEG → 遍历 APP1 段提取 XMP → 查找 `Camera:MicroVideoOffset`
   或含 `Item:Semantic="MotionPhoto"` 的 `Container:Directory`
   → **必须实际校验**：`文件长度 − offset` 处确实以合法 ISO-BMFF `ftyp` 开头。
3. HEIC → 检查 `meta` 中的 MotionPhoto 项 → `google-motionphoto-heif`（仅识别与提取）。
4. MOV/MP4 → 读 QuickTime keys 中的 content identifier；
   若同批拖入的静图携带相同标识（退而求其次：同名）→ `apple-paired`。
5. **多文件配对**：先按 content identifier 匹配，再按文件名，最后询问用户。
   配对后 UI 应显示为**一个条目**并标注 Live Photo，而非两个文件。
   需支持手动配对与解除配对。

### 拆包

- `apple-livp`：解压 ZIP。
- `apple-paired`：直接分离。
- `google-motionphoto-jpeg`：静图 = `blob[0 .. len-offset]`，视频 = `blob[len-offset ..]`。
  导出静图时应**剥离已成为谎言的** Motion Photo XMP（默认剥离，提供开关）。
- 静图缺失时，可用视频在 `stillImageTimeSec` 处取帧重建，并标注
  `still-image-time-track-missing`。

### 重新封装

**Google Motion Photo（先做这一条——不需要兜底引擎）**

1. 产出静图 JPEG。
2. 用主干引擎产出 MP4，`moov` 置于文件前部。
3. 手工构造 XMP 包，写入 JPEG 的 APP1，然后拼接 `jpeg || mp4`。
   `Camera:MicroVideoOffset` 写为 `mp4.length`（从末尾起算的语义），同时写 `Container:Directory` 形式。
4. **自校验**：重新用识别器读一遍产物，断言 offset 可解析且指向合法 `ftyp`。
   自校验应当是任务的一部分，而不是留给测试。

**Apple Live Photo**

1. 生成 `crypto.randomUUID().toUpperCase()`。
2. **MOV 打标走兜底引擎（ffmpeg）**：

   ```
   -c copy -movflags use_metadata_tags \
   -metadata com.apple.quicktime.content.identifier=<UUID>
   ```

   **`-movflags use_metadata_tags` 是必需的**。省略它，元数据会被写进 `udta` 而非
   `keys`/`ilst`，`ffprobe` 读不到，而且**不报错**。
   为什么不走主干引擎，见 `docs/DECISIONS.md` ADR-004——那里有一次被实测推翻的推断记录。

3. 静图侧写入 `apple:ContentIdentifier` 到 XMP（手写，见下）。
4. **`still-image-time` 轨道在 v1 中省略**：写入一条单样本定时元数据轨道需要重写 `moov` 盒树。
   Photos.app 在缺失时仍可导入（回落到第 0 帧），仅表现为静帧可能与视频首帧不重合。
   以 `info` 级标注 `still-image-time-track-missing` 并写进文档。
   只有在其自校验往返测试（写 → 用主干引擎重新解析 → 断言键与轨道存在）通过后，才可交付。
5. 目标是 `.livp` 时用 **`level: 0`（不压缩）** 打包——对已压缩媒体再压缩毫无收益，存储则是瞬时的。
6. **默认输出 `.livp`**，次选「两个文件」。UI 须如实说明：浏览器生成的 Live Photo
   导入 Photos.app 并不可靠；`.livp` 可通过 AirDrop/存储后导入。

### 手写 XMP 写入器

读取用 `exifreader`；写入**没有维护中的库，必须手写**：

- **JPEG**：从 SOI 遍历标记，在 APP0/JFIF 之后插入新的 APP1
  （命名空间 `http://ns.adobe.com/xap/1.0/\0` + 包体）。若已存在 XMP APP1，
  **替换而非追加**（Google Photos 读第一个）。包体约 700 字节，远低于 65533 字节上限，
  但**必须断言并在超限时抛错**，不得静默截断。
- **PNG**：在 `IDAT` 之前插入 `iTXt` 块，关键字 `XML:com.adobe.xmp`，压缩标志 0，
  空语言标签，UTF-8 包体，并自行计算 CRC-32。
- **WebP**：`XMP ` RIFF 块要求存在 `VP8X`；把简单格式 WebP 升级为扩展格式是一次有风险的改写。
  **本期不做**——Motion Photo 与 WebP 无关，而描述性 XMP 的保留由元数据策略覆盖。
- **HEIC**：需要改写 `iinf`/`iloc`/`idat`，v1 不做。

## 输入 / 输出

- **输入**：一个文件（`.livp` / Motion Photo / 成对拖入的两个文件）
- **输出**：拆包时为静图 + 视频两个文件；封装时为 `.livp`（默认）或两个文件

## 约束

- 识别**不得**只依赖 XMP 标记——`Camera:MotionPhoto` 在视频被剥离后仍可能残留。
- 静图默认用 **JPEG 而非 HEIC**：这正是 iOS「兼容性最佳」模式下 Apple 自身的产物形态，
  且避开了浏览器内 HEIC 编码的可行性与专利问题。
- 剥离已被消耗的 Motion Photo XMP 应当是默认行为。

## 边界条件

- 标识存在但配对的另一半不在——提示用户补拖入，而不是静默当作普通文件。
- XMP 的 offset 陈旧（文件被编辑过）——以实际 `ftyp` 校验为准。
- `.pvt` 没有公开规范，是第三方工具的临时目录形态，**不作承诺**。
- HEIC 形态的 Motion Photo **只能识别与提取，不能生成**。

## 验收标准

- [ ] 四种形态均可识别（含 offset 陈旧与 XMP 残留的负例）
- [ ] Apple 解包后，MOV 的 content identifier 可被 `ffprobe` 读回
- [ ] Google 封装产物的 offset 自校验通过
- [ ] 生成的 Apple Live Photo，其 MOV 标识与静图 XMP 标识一致
- [ ] 手动配对/解除配对可用
- [ ] HEIC 形态在 UI 上明确标注「仅支持提取」

## 完成定义

四种形态的识别与拆包、Google 形态的生成、Apple 形态的生成（标识配对 + 静帧 + MOV）
全部可用；`still-image-time` 轨道作为已知增量缺口被文档化。

## 当前实现状态

| 能力 | 状态 |
| --- | --- |
| Apple `.livp` 识别与拆包 | ✅ |
| Apple 成对识别与拆包 | ✅ |
| Google Motion Photo 识别与拆包 | ✅ |
| Google Motion Photo 生成 | ✅（封装层已实现，UI 入口待接） |
| Apple `.livp` 打包 | ✅（用于已打标的 MOV） |
| Apple MOV 打标（content identifier） | ⏳ 需要兜底引擎，尚未接入 |
| `still-image-time` 定时元数据轨道 | ⏳ 已知缺口，见下 |

### 打包器的自校验

`buildMotionPhoto` 与 `buildLivp` **在返回前会用对应的探测器重新读一遍自己的产物**，
不一致即抛错。一个「看起来对、但打不开」的 Live Photo 是最坏的结果，
而探测器本来就在手边，这个检查几乎不花钱。

### 一个诚实的局限

测试样本由本项目自己的打包器产出，因此往返测试**无法发现打包器与探测器共享的误解**。
单元测试通过直接断言格式规范里的字节级性质来补偿：
`MicroVideoOffset` 是否等于视频长度、该偏移处是否确实以合法的视频容器开头、
现代与旧版两套 XMP 字段是否都在。这些性质另用 `file` / `ffprobe` / `unzip`
在外部工具上独立复核过。
