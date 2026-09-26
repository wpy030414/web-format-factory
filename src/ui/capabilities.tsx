import { useEffect, useState } from 'react';
import { CircleCheck, CircleX, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils.ts';
import { probeCapabilities, type Capabilities, type CodecTable } from '@/core/caps.ts';
import { codecLabel } from '@/core/codecs.ts';

/**
 * The capability report.
 *
 * This exists because the app's behaviour depends on things that vary wildly between
 * machines and are invisible from the outside — whether VP9 can be encoded here, whether
 * HEIC decodes natively, whether cross-origin isolation is actually on. When something
 * does not work, this page is the first place to look; when someone reports a problem,
 * this page is what you ask them for.
 */
export function CapabilitiesPage() {
  const [caps, setCaps] = useState<Capabilities | null>(null);

  useEffect(() => {
    void probeCapabilities().then(setCaps);
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-5 py-10">
      <header className="mb-7">
        <h1 className="text-2xl font-semibold tracking-tight">本机能力诊断</h1>
        <a href="#/" className="text-muted-foreground hover:text-foreground mt-3 inline-block text-xs">
          ← 返回转换器
        </a>
      </header>

      {!caps && (
        <p className="text-muted-foreground inline-flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> 正在探测…
        </p>
      )}

      {caps && (
        <div className="space-y-6">
          <Section title="运行环境">
            <Row
              label="跨源隔离（COOP/COEP）"
              ok={caps.crossOriginIsolated}
              okText="已开启"
              badText="未开启"
              hint="兜底引擎唯一的硬性前提。未开启时它不会报错，而是静默挂起。"
            />
            <Row label="SharedArrayBuffer" ok={caps.sharedArrayBuffer} hint="多线程 WASM 的前提。" />
            <Row label="Web Worker" ok={caps.webWorkers} hint="所有转换都在 Worker 里跑。" />
            <Row label="OffscreenCanvas" ok={caps.offscreenCanvas} />
            <Row
              label="ImageDecoder（帧级图像 API）"
              ok={caps.imageDecoder}
              badText="不可用"
              hint="动图取帧的快路径。Safari 上仍为 preview。"
            />
            <Row
              label="原生 HEIC 解码"
              ok={caps.heicNative}
              okText="支持"
              badText="不支持，将使用内置解码器"
              hint="Safari 17+ 支持。不支持时会多下载一个约 3MB 的解码器。"
            />
          </Section>

          <CodecSection title="视频编码" table={caps.videoEncode} />
          <CodecSection title="视频解码" table={caps.videoDecode} />
          <CodecSection title="音频编码" table={caps.audioEncode} />
          <CodecSection title="音频解码" table={caps.audioDecode} />
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">{title}</h2>
      <div className="border-border divide-border divide-y rounded-lg border">{children}</div>
    </section>
  );
}

function CodecSection({ title, table }: { title: string; table: CodecTable }) {
  return (
    <Section title={title}>
      <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
        {Object.entries(table).map(([id, ok]) => (
          <div key={id} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs">
            {ok ? (
              <CircleCheck className="text-fidelity-lossless size-3 shrink-0" />
            ) : (
              <CircleX className="text-muted-foreground size-3 shrink-0" />
            )}
            <span className={cn(!ok && 'text-muted-foreground')}>{codecLabel(id)}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Row({
  label,
  ok,
  okText,
  badText,
  hint,
}: {
  label: string;
  ok: boolean;
  okText?: string;
  badText?: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-2 px-2.5 py-2">
      {ok ? (
        <CircleCheck className="text-fidelity-lossless mt-0.5 size-3.5 shrink-0" />
      ) : (
        <CircleX className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
      )}
      <div>
        <p className="text-xs">
          {label}
          <span className={cn('ml-1.5', ok ? 'text-fidelity-lossless' : 'text-muted-foreground')}>
            {ok ? (okText ?? '可用') : (badText ?? '不可用')}
          </span>
        </p>
        {hint && <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">{hint}</p>}
      </div>
    </div>
  );
}
