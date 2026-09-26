# Research — 生成的 Live Photo 怎么进相册，以及相册到底认什么

- **日期**：2026-09-26
- **环境**：macOS 27.0 (26A428)、Photos 12.0、ffmpeg 9.0.1、exiftool 13.55、swiftc（Command Line Tools）
- **起因**：用户提问「网页生成的 `.livp` 怎么导入 iOS/macOS 相册？」——问的是用法，查出来的却是产品缺口。
- **状态**：结论已有实测支撑，并在**我们应用自己产出的 `.livp` 上端到端验证通过**（§7）。本文保留了四次被推翻的中间结论——那份记录本身是资产。

**一句话结论**：`.livp` 本身**导不进相册**；解压成对之后，两个文件要被认成一张 Live Photo，需要**两样同时成立**：

1. **静图**带 Apple 的 MakerNote 标识（`kCGImagePropertyMakerAppleDictionary` 的 key 17）；
2. **视频**的 `content identifier` 写在 **QuickTime 形态的 `moov/meta`** 里——`meta` 盒**没有 version/flags**，且**直接挂在 `moov` 下**。

我们的产物两样都没有：标识只写进了视频的 `udta/meta`（ISO 形态），静图一个字也没写。

> ⚠️ **本文第 5 节曾经给出过一个不同的结论（「`mebx` 轨道是必需的」），它已经被第 6 节的减法实验推翻。**那一段连同推翻过程一并保留在 §5，不要只读那一段。

---

## 1. 方法：怎么判定「配对成了没有」

主判据：

```applescript
tell application "Photos" to import {POSIX file "…-live.jpg", POSIX file "…-live.mov"}
```

返回的 `media item` 条数：**1 条 = 合成了一张 Live Photo，2 条 = 各自成了独立素材**。

**这个判据有一个洞，中途咬过我们一次**：文件损坏导致其中一个根本没导进去时，也会返回「1 条」（§4 第四次更正）。所以每条「1 条」的结论都必须配一次**磁盘复核**：

```
~/Pictures/Photos Library.photoslibrary/originals/<xx>/<uuid>.jpeg
~/Pictures/Photos Library.photoslibrary/originals/<xx>/<uuid>_3.mov     ← 共用 UUID 主干 = 真配对
```

贯穿全篇的一条纪律：**同步/异步、去重、复用 UUID 都会污染图库的事后状态**，所以结论只认「导入瞬间的返回条数 + 紧随其后的磁盘复核」，不认「过一会儿再看图库长什么样」。

## 2. 第一件事：`.livp` 不能直接导入

**① 系统层面不认识这个类型**

```
$ mdls -name kMDItemContentType /tmp/probe.livp
kMDItemContentType = "dyn.ah62d4rv4ge8024p0sa"      ← 动态 UTI，即「未知类型」
```

Photos.app 的 `Info.plist` 里没有任何 `.livp` 声明。`.livp` 是 Apple 的**传输容器**（iCloud 网页版下载 Live Photo 给的就是它），从没被做成可导入的媒体类型。

**② 行为层面**

```
$ osascript -e '… import {POSIX file "…/live.livp"}'
报错 -10006: 不能将"every item"设置为"{}"。；库 0 → 0
```

导入 **0 条**。**必须先解压成对。**

顺带记一个操作事实：这一版 macOS 上 **Photos 的 AppleScript `delete` 已失效**（`-10000`），清理只能靠界面。

## 3. 第一轮：静图的标识写在哪一侧

| 变体 | 静图侧标识 | 视频侧标识 | 结果 |
| --- | --- | --- | --- |
| A（产品原样） | ✗ | ✓ | 2 条 |
| B | ✓ MakerNote key 17 | ✓ | 2 条 |
| C | 只有 **XMP** `apple:ContentIdentifier` | ✓ | 2 条 |

B 组的 MakerNote 用 **Core Graphics** 写（`CGImageDestination` + `kCGImagePropertyMakerAppleDictionary["17"]`，见附录），刻意不手搓字节。

**这一轮单独看说明不了什么**（缺阳性对照），但它证明了一件事：**光把静图标识补上不够。**

## 4. 更正记录（四次，都保留）

四次更正里有三次是**实验设计**的错，一次是**判据**的错。形状和 `AGENTS.md` 那条是同一个：**先确认手里的对照物真的成立，再拿它去否定或肯定什么。**

**第一次：拿被剥掉标识的样本当阳性对照。**
从公开仓库取到一对看起来像 Apple 产物的样本，走同一条导入路径得到 2 条，于是宣布「Photos 的文件导入根本不配对」。**错的**：那对样本的标识已被剥掉（XMP 里留着 `XMPToolkit: Image::ExifTool`，`[Apple]` MakerNote 组整个不存在，MOV 里也没有 `content.identifier`）。拿一个不成立的样本去否定一个尚未检验的假设。

**第二次：对着被自己污染的图库状态下结论。**
同一轮实验里复用了同一个 UUID，相册后台据此把 4 个视频与 3 张静图交叉撮合，库里出现 3 组配对、且都指向同一份视频资源。**事后状态是我的实验设计污染的**，不能用来下结论。

**第三次（最严重）：把「ffmpeg 重封过的文件」当成了「只差一条轨道」。**
见 §5——那条结论错得最久，也最值得看。

**第四次：判据本身有洞。**
「1 条 = 配对」在**文件损坏**时会误报：一次错误的字节删除毁掉了 MOV，导入返回「1 条」，看起来像配对成功，实际是**只有静图进去了**。补上磁盘复核之后才对上账。

## 5. 对照 P / Q —— 以及它为什么是错的

> **本节结论已被 §6 推翻，保留原文以示过程。**

重新设计过的一组对照：P（红图 + Apple 的 MOV，带 `mebx`）与 Q（蓝图 + 同一份 MOV 经 ffmpeg 重封，丢掉 `mebx`），**只有 `mebx` 一处差别**——当时是这么以为的。

| 变体 | 导入返回 | 磁盘复核 |
| --- | --- | --- |
| P | 1 条 | 成对资源 ✓ |
| Q | 2 条 | 独立条目 |

于是当时下了结论：**`mebx` 轨道是必需的**。**这个结论是错的**，原因在于「只有一处差别」这个前提不成立：Q 是 **ffmpeg 重封**过的，而 ffmpeg 重封除了丢掉 `mebx`，还顺手改了音频标签、丢了若干盒、并把元数据搬到了 `udta/meta`（ISO 形态）。**我拿一个差异不止一处的对照，去归因其中一处。**这正是第一次更正里那个错的重演，只是这次隔了几节才被发现。

真正把 `mebx` 钉死的实验是 §6 的减法——那次它被排除得很干脆。

## 6. 减法实验：真正的两样

加法（往我们的文件上加东西）一路受 ffmpeg 重封的污染，于是改成**减法**：从 Apple 那份**能配对**的文件上，一次拆掉一样，其余一动不动。

### 6.1 先排除 `mebx`

Apple 的 MOV 里有三条 meta 轨道：`video-orientation`、`live-photo-info`、`still-image-time`（后者就是 ADR-009 说的那条）。

| 变体 | 拆掉了什么 | 结果 |
| --- | --- | --- |
| A0 | 没拆（对照） | 1 条 ✓ |
| A1 | `still-image-time` | **1 条 ✓** |
| A2 | `live-photo-info` | **1 条 ✓** |
| A3 | `video-orientation` | **1 条 ✓** |
| M3 | **三条一起拆** | **1 条 ✓** |

**三条 meta 轨道一条都不是必需的**，`still-image-time` 也不是。ADR-009 那条「不写 `still-image-time`」**不是**配对失败的成因——它仍然是「与 Apple 产物不完全一致」，但对**能不能进相册**没有影响。

### 6.2 再锁定真正的差异：`moov/meta` 的形态与位置

排除掉轨道之后，剩下的差异集中在一处：**Apple 把电影级元数据写成 `moov/meta`，ffmpeg 写成 `moov/udta/meta`**——不止是位置不同，**字节形态也不同**：

```
Apple  moov/meta : 00 00 03 81 6d 65 74 61 | 00 00 00 22 68 64 6c 72   ← 盒头之后直接是子盒
ffmpeg udta/meta : 00 00 04 46 6d 65 74 61 | 00 00 00 00 | 00 00 00 21 68 64 6c 72
                                              └ version/flags（ISO 风格多出来的 4 字节）
```

三种组合，两两对照：

| 变体 | meta 的形态 | meta 的位置 | 结果 |
| --- | --- | --- | --- |
| **QT** | QuickTime 风格（无 version/flags） | **直接挂在 moov 下** | **1 条 ✓** |
| SF | QuickTime 风格 | 仍在 `udta` 里 | 2 条 |
| U1 | ISO 风格（有 version/flags） | 挂在 moov 下 | 2 条 |

**两样都得对**：形态要 QuickTime（无 version/flags），位置要直接在 `moov` 下。缺任何一样，Apple 的读取端就找不到那个 `content identifier`。

### 6.3 结论

进相册需要**两样**：

1. **静图**：Apple MakerNote 的 key 17（不是 XMP）。
2. **视频**：`content identifier` 落在 **QuickTime 形态的 `moov/meta`** 里。

## 7. 端到端验证：拿我们应用自己产出的 `.livp` 做

不用样本、不用 Apple 的素材，用**用户实际下载到的那个 `.livp`**（我们的应用产出的）：

| | 修正前 | 修正后 |
| --- | --- | --- |
| 静图 | 无任何标识 | Core Graphics 写入 MakerNote key 17 = MOV 里的标识 |
| 视频 | 标识在 `udta/meta`，ISO 形态 | 提到 `moov` 下，去掉 version/flags |
| 其他 | 只有视频流（无 `mebx`） | 没动 |

**导入结果：1 条**，磁盘复核 `0E108EE2-…jpeg` 与 `0E108EE2-…_3.mov` 共用 UUID 主干——**它真的成了相册里的一张 Live Photo。**

两处修正都是**纯字节手术**，浏览器里做得到（不需要 Core Graphics，也不需要合成 `mebx` 轨道——后者一度看起来是最大的一块，结果根本不需要）。

## 8. 对项目的意义

### 8.1 缺的是这两样，不是那两样

| | 现状 | 需要 |
| --- | --- | --- |
| 静图（`#stillFromFrame` 产出的 JPEG） | 不带任何标识 | 写 Apple MakerNote key 17 |
| 视频（ffmpeg.wasm 产出的 MOV） | 标识在 `udta/meta`（ISO 形态） | 搬到 `moov/meta` 并去掉 version/flags |
| `still-image-time` 轨道 | 不写 | **不需要**（§6.1 实测） |

### 8.2 `docs/specs/live-photo.md` §3 的悬案：读取端确实读错了字段

规格里怀疑「我们的探测器从静图 XMP 读标识，而 Apple 实际写在 MakerNote」。本轮实测支持这一点：C 组静图带 XMP 标识**配不上**；带 MakerNote 的**配得上**。至少**相册的导入路径不读那个 XMP 字段**。

### 8.3 ADR-009 要改，但不是往「更严重」的方向改

ADR-009（不写 `still-image-time`）当时说「缺少它的实际影响未经实测，所以既不宣称无害，也不宣称有害」。**现在实测了：对「能不能进相册」没有影响**（§6.1，三条轨道全拆掉照样配对）。所以它仍然是一个「与 Apple 产物不一致」的缺口，但**不是**配对失败的原因——这一点必须写清楚，免得后来者拿它当替罪羊。

### 8.4 浏览器里怎么写

两处都不需要 Apple 框架：

- **静图 MakerNote**：需要构造/改写 EXIF 的 APP1 段，并写入 Apple MakerNote（`Apple iOS\0…` 头 + IFD，键 17）。**参照物已经拿到**：附录的探针可以现场产出一份，直接读它的字节。
- **MOV 的 meta**：把 `moov/udta/meta` 提到 `moov` 下并去掉 4 字节 version/flags，同时修正 `moov` 尺寸——**本轮已用 Python 实现并验证**（`qt_meta.py` 的算法就是最终需要移植的那几十行）。

ADR-004 / ADR-009 拒绝过的「凭二手描述手写字节」在这里不再适用：**两处都是对着真实产物反推、并在真机上验收过的。**

**已经落地**：`src/livephoto/apple.ts` 实现了这两样（`buildAppleMakerNote` / `writeAppleMakerNote`
/ `relocateMovieMeta`），引擎已接上。验收方式与本文一致，只是把探针换成了真应用：
在浏览器里跑构建产物产出一个 `.livp` → 解压 → 导入相册 → **1 条**，磁盘复核成对。
静图的 MakerNote 单测直接与 Core Graphics 写出的 69 字节逐字节对齐。

## 9. 遗留问题

- **iOS 侧完全没测。**本机只有 macOS，`AirDrop 到 iPhone` 这条最常被推荐的路一次都没验证。
- **导入以外的路径没测**：设备导入、iCloud、PhotoKit 的 `PHAssetCreationRequest`。
- **JPEG 之外**：HEIC 静图、HEVC/AVC 视频是否同样成立，没有分离验证。
- **MakerNote 的最小形态未知**：Core Graphics 写的那个 MakerNote 里只有键 17，但 Apple 的完整 MakerNote 还有几十个键。是否「只有 17 就够」在本轮是**是**（P/QT 都是只有 17 就配上了）。
- **未清理**：本轮往图库导入了若干测试素材（`delete` 失效，§2），需手工全选删除。

## 10. 参照物在哪

真实 Apple 产物存放在 `~/Downloads/apple-livephoto-reference/`：

| 文件 | 来源 | 可验证的 Apple 特征 |
| --- | --- | --- |
| `test2.mov` | `RhetTbull/makelive` 的测试样本 | `make=Apple`、`model=iPhone SE (2nd generation)`、`software=17.3.1`、`live-photo.auto=1`、3 条 `mebx` 轨道。注意标识已被剥掉 |
| `test2.heic` | 同上 | `Make=Apple`、Apple ICC |
| `pairedVideo.mov` | `LimitPoint/LivePhoto` 的 Apple sample code 资产 | `content identifier` 完整、1 条 `mebx`、creation_time 2018-01-05 |
| `keyPhoto.jpg` | 同上 | Apple 静图；MakerNote 与 XMP 标识均已被剥掉 |

**来源强度**：这些文件的前缀元数据支持它们是 Apple 产物，但不如一台自己手上的 iPhone 导出的文件权威。

## 11. 复现方法

```bash
# 判定配对（返回 1 条后，务必再做一次磁盘复核）
osascript -e 'tell application "Photos" to import {POSIX file "/path/x-live.jpg", POSIX file "/path/x-live.mov"}'
ls ~/Pictures/Photos\ Library.photoslibrary/originals/*/

# 给静图写 Apple MakerNote（附录的探针）
swiftc -O mkmakernote.swift -o mkmakernote
./mkmakernote in.jpg out.jpg <UUID>
exiftool -a -G1 -s out.jpg | grep ContentIdentifier     # 期望 [Apple] ContentIdentifier

# 把视频的元数据改成 Apple 的形态：moov/udta/meta → 裸 meta 挂在 moov 下，并去掉 4 字节 version/flags
# （算法见本轮探针；这一步是纯字节搬运 + moov 尺寸修正）
```

**反例也是信息**：ffmpeg 的 `-movflags use_metadata_tags` 会把标识写进 `udta/meta` 的 ISO 形态 `meta` 里——**这正是我们的产物配不上的直接原因**。

---

## 附录：写 Apple MakerNote 的探针

`makelive` 的 README 说得很直接：标识「stored in Maker Notes which exiftool cannot create」。
实证：`exiftool -Apple:ContentIdentifier=…` 在裸 JPEG 上不报错也不写入（`1 image files unchanged`），先建 EXIF 也一样。能创建它的是 Core Graphics。

```swift
import Foundation
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics

// 用 Core Graphics 给 JPEG 写 Apple 的 MakerNotes（key 17 = content identifier）。
// MakerNotes 的字节布局不自己拼，只把语义交给框架。
guard CommandLine.arguments.count == 4 else {
    FileHandle.standardError.write("usage: mkmakernote <in.jpg> <out.jpg> <uuid>\n".data(using: .utf8)!)
    exit(2)
}

let inURL = URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL
let outURL = URL(fileURLWithPath: CommandLine.arguments[2]) as CFURL
let uuid = CommandLine.arguments[3]

guard let src = CGImageSourceCreateWithURL(inURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil),
      let dest = CGImageDestinationCreateWithURL(outURL, UTType.jpeg.identifier as CFString, 1, nil)
else {
    FileHandle.standardError.write("无法读取源图，或无法创建输出\n".data(using: .utf8)!)
    exit(1)
}

var props = (CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]) ?? [:]
props[kCGImagePropertyMakerAppleDictionary] = ["17": uuid]

CGImageDestinationAddImage(dest, image, props as CFDictionary)

guard CGImageDestinationFinalize(dest) else {
    FileHandle.standardError.write("写入失败\n".data(using: .utf8)!)
    exit(1)
}

print("ok: \(CommandLine.arguments[2])")
```

**注意**：该探针会把 JPEG 重新编码（`CGImageDestinationAddImage`）。做实验没问题；产品路径要考虑重编码质量与元数据保留。
