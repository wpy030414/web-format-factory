# Spec — 格式矩阵

## 要构建什么

一份权威的「源格式 × 目标格式」可达性与代价表，供路由层与 UI 共同消费。
它是 `docs/PRD.md` 中语义边界的可执行形式。

## 行为

给定一个**由内容探测得出**的源媒体类别（而非扩展名），对每一个目标格式回答三件事：

1. 是否可达；
2. 若可达，需要哪种转换（原样复用 / 重新编码 / 投影）；
3. 若不可达，理由是什么，以及有哪些可行的替代格式。

## 输入 / 输出

- **输入**：`MediaClass`（video / animated-image / still-image / audio / live-photo / unknown）
  与 `FormatId`。
- **输出**：`Verdict`，三选一：
  - `{ kind: 'direct' }` —— 目标直接接受该类别
  - `{ kind: 'project', projector }` —— 可达，但需一次投影
  - `{ kind: 'impossible', reason }` —— 不可达，附归因

## 格式清单

**影像线**：JPEG、PNG、APNG、WebP、动态 WebP、GIF、MP4、MOV、MKV、WebM、Live Photo
**音频线**：M4A、MP3、AAC、FLAC、WAV、OGG

### 关键容器特征

| 格式 | 容器 | 类别 | 透明 | 动图 | 备注 |
| --- | --- | --- | --- | --- | --- |
| JPEG | JFIF/EXIF | 静图 | 无 | 否 | alpha 输入必须声明降级 |
| PNG / APNG | PNG | 静图 / 动图 | 完整 | 支持 | APNG 体积通常远大于 GIF |
| WebP / 动态 WebP | RIFF | 静图 / 动图 | 完整 | 支持 | **动态编码需兜底引擎** |
| GIF | GIF89a | 动图 | 二值 | 必须 | 256 色 + 10 ms 时间粒度 |
| MP4 | ISO-BMFF (`isom`/`mp42`) | 视频 | 无 | 否 | 不支持多音轨 |
| MOV | ISO-BMFF (`qt  `) | 视频 | 无 | 否 | Live Photo 的载体 |
| MKV | EBML `matroska` | 视频 | 无 | 否 | 最宽松；源 MKV 的额外轨道可能被丢弃 |
| WebM | EBML `webm` | 视频 | 完整(VP9) | 否 | 少数能携带透明的视频容器 |
| M4A | ISO-BMFF (`M4A `) | 音频 | — | — | 本质是 MP4 的音频子集 |
| MP3 | MPEG-1/2 L3 | 音频 | — | — | 编码需 LAME wasm |
| AAC | ADTS 裸流 | 音频 | — | — | |
| FLAC | FLAC | 音频 | — | — | 无损压缩，但无法修复有损源 |
| WAV | RIFF | 音频 | — | — | 未压缩，体积大 |
| OGG | Ogg | 音频 | — | — | 推荐 Opus；真 Vorbis 需兜底引擎 |

### 容器辨识要点

MP4 / MOV / M4A / HEIC **全是 ISO-BMFF**，只能靠 `ftyp` 的 major brand 区分：
`qt  ` = MOV、`M4A ` = M4A、`heic`/`mif1` = HEIC、`isom`/`mp42` = MP4。
MKV 与 WebM 同为 EBML，靠 DocType 区分。**因此识别必须走魔数，不得信扩展名。**

## 约束

- 转换类别必须由 `kindOf()` 从两轴推导，不得声明。
- 损失项必须对真实探测结果求值，不得使用静态清单。
- 表格必须**穷举**：全部媒体类别 × 全部目标格式，无一遗漏。

## 边界条件

- 扩展名与内容不符（`.jpg` 实际是 PNG）——以内容为准，并在 UI 上提示。
- `.jpg` 可能是静图、Google Motion Photo、或 Live Photo 的静态半。
- `.mov` 可能是普通视频，也可能是 Live Photo 的视频半。
- 无法识别的文件 → `unknown` 类别，全部目标显示为不可达并给出 `class-mismatch`。

## 验收标准

- [ ] 全部媒体类别 × 全部目标格式的判定结果被快照测试锁定
- [ ] 每条 `impossible` 都带有非空 `reason`
- [ ] 音频对视频/图像目标的判定为 `needs-visual-component` 或 `class-mismatch`
- [ ] 静图对动图目标为 `needs-multiple-frames`，对 Live Photo 为 `livephoto-needs-video`
- [ ] Live Photo 对视频目标为 `split-video`，对静图目标为 `split-still`
- [ ] 每个 `ParamSpec.id` 均位于 `SCOPE_ALLOWLIST` 内

## 完成定义

上列验收标准全部通过，且 `verdictFor()` 对任意输入不抛异常。
