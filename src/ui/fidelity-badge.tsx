import { CircleCheck, TriangleAlert, Layers, Zap, Clock, Download } from 'lucide-react';
import { cn } from '@/lib/utils.ts';
import type { Fidelity } from '@/core/types.ts';
import type { LossItem } from '@/core/loss/codes.ts';

const FIDELITY_META: Record<Fidelity, { label: string; hint: string; className: string }> = {
  lossless: {
    label: '无损',
    hint: '编码数据原样复制，不重新压缩。',
    className: 'text-fidelity-lossless border-fidelity-lossless/30 bg-fidelity-lossless/10',
  },
  lossy: {
    label: '有损',
    hint: '画面或声音将被重新压缩，会损失一部分数据。',
    className: 'text-fidelity-lossy border-fidelity-lossy/30 bg-fidelity-lossy/10',
  },
  projection: {
    label: '投影',
    hint: '媒介类别改变，必须丢弃或选取内容维度。',
    className:
      'text-fidelity-projection border-fidelity-projection/30 bg-fidelity-projection/10',
  },
};

export function FidelityBadge({ fidelity }: { fidelity: Fidelity }) {
  const meta = FIDELITY_META[fidelity];
  const Icon = fidelity === 'lossless' ? CircleCheck : fidelity === 'projection' ? Layers : TriangleAlert;
  return (
    <span
      title={meta.hint}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium',
        meta.className,
      )}
    >
      <Icon className="size-3" />
      {meta.label}
    </span>
  );
}

/** How much work this will be — distinct from how much it costs in quality. */
export function SpeedBadge({ did }: { did: 'transmux' | 'transcode' }) {
  const instant = did === 'transmux';
  const Icon = instant ? Zap : Clock;
  return (
    <span
      title={instant ? '仅更换容器，几乎瞬时完成。' : '需要重新编码，耗时与文件大小相关。'}
      className={cn(
        'text-muted-foreground inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
        instant ? 'border-border' : 'border-border',
      )}
    >
      <Icon className="size-3" />
      {instant ? '瞬时（换容器）' : '需重新编码'}
    </span>
  );
}

/** Render the loss list, most severe first. */
export function LossList({ items }: { items: readonly LossItem[] }) {
  if (items.length === 0) return null;
  const order = { critical: 0, warn: 1, info: 2 } as const;
  const sorted = [...items].sort((a, b) => order[a.severity] - order[b.severity]);

  return (
    <ul className="mt-2 space-y-1">
      {sorted.map((item, i) => (
        <li key={`${item.code}-${i}`} className="flex items-start gap-1.5 text-xs">
          <SeverityDot severity={item.severity} />
          <span className={item.severity === 'critical' ? 'text-foreground' : 'text-muted-foreground'}>
            {LOSS_COPY[item.code]}
            {item.detail ? ` — ${item.detail}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SeverityDot({ severity }: { severity: LossItem['severity'] }) {
  const cls =
    severity === 'critical'
      ? 'bg-destructive'
      : severity === 'warn'
        ? 'bg-fidelity-lossy'
        : 'bg-muted-foreground/50';
  return <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', cls)} aria-hidden />;
}

export function DownloadButton({ onClick, name }: { onClick: () => void; name: string }) {
  return (
    <button
      type="button"
      data-testid="download-result"
      onClick={onClick}
      className="border-border hover:bg-accent inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium"
    >
      <Download className="size-3" />
      下载 {name}
    </button>
  );
}

/**
 * Plain-language copy for every loss code.
 *
 * Written as consequences rather than jargon: "画面透明度将被丢弃" tells the user what
 * they lose, where "alpha-flattened" tells them nothing.
 */
export const LOSS_COPY: Record<LossItem['code'], string> = {
  requantized: '画面或声音将被重新压缩',
  'quantized-colors': '颜色将被压缩到 256 色以内',
  'chroma-subsampled': '色彩分辨率将被降低',
  'bit-depth-reduced': '色彩位深将被降低',
  'sample-rate-changed': '音频采样率将改变',
  'channels-downmixed': '声道数将减少',
  'generation-loss-from-lossy-source': '源文件已经有损，转无损格式并不会有画质或音质提升',
  'alpha-flattened': '透明度将被丢弃',
  'alpha-dropped': '透明度将被丢弃',
  'hdr-tonemapped': '高动态范围将被压缩为普通范围',
  'orientation-baked': '照片方向将被固化进像素',
  'extra-tracks-dropped': '部分轨道将被丢弃',
  'companion-still-dropped': 'Live Photo 的静态图将被丢弃',
  'companion-video-dropped': 'Live Photo 的视频部分将被丢弃',
  'frames-coalesced': '连续相同的帧将被合并',
  'frame-timing-quantized': '帧间隔将被量化到 10 毫秒',
  'frames-dropped': '部分帧将被丢弃',
  'frame-selected': '将从动态内容中选取一帧',
  'still-image-time-track-missing': '未写入静帧的时间标记轨道',
  'metadata-exif-dropped': 'EXIF 信息将丢失',
  'metadata-xmp-dropped': 'XMP 信息将丢失',
  'metadata-icc-dropped': '色彩配置文件将丢失',
  'metadata-icc-assumed-srgb': '色彩将被当作 sRGB 处理',
  'metadata-gps-stripped': 'GPS 位置信息将被移除',
  'metadata-container-keys-dropped': '部分容器级元数据将丢失',
};
