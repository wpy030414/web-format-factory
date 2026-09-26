import { useCallback } from 'react';
import { Play, Download, Trash2, Loader2, ShieldCheck } from 'lucide-react';
import { useStore } from '@/state/store.ts';
import { Dropzone } from '@/ui/dropzone.tsx';
import { FileCard } from '@/ui/file-card.tsx';

export function App() {
  const files = useStore((s) => s.files);
  const running = useStore((s) => s.running);
  const addFiles = useStore((s) => s.addFiles);
  const startAll = useStore((s) => s.startAll);
  const downloadAll = useStore((s) => s.downloadAll);
  const clearFinished = useStore((s) => s.clearFinished);

  const onFiles = useCallback(
    (incoming: File[]) => {
      void addFiles(incoming);
    },
    [addFiles],
  );

  const readyCount = files.filter(
    (f) =>
      f.profile &&
      f.target &&
      f.status !== 'done' &&
      f.status !== 'running' &&
      f.status !== 'queued',
  ).length;
  const doneCount = files.filter((f) => f.status === 'done').length;
  const blocked = files.filter(
    (f) => f.status === 'ready' && f.profile && (!f.target || f.profile.mediaClass === 'unknown'),
  ).length;

  return (
    <div className="mx-auto max-w-3xl px-5 py-10">
      <header className="mb-7">
        <h1 className="text-2xl font-semibold tracking-tight">Web Format Factory</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          影像与音频的格式互转，全部在这台设备上完成。
          <span className="text-foreground"> 转换前会告诉你代价</span>
          ——会丢什么、会不会重新压缩、哪些格式做不到以及为什么。
        </p>
      </header>

      <Dropzone onFiles={onFiles} compact={files.length > 0} />

      {files.length > 0 && (
        <>
          <div className="border-border mt-6 flex flex-wrap items-center gap-2 border-y py-3">
            <button
              type="button"
              onClick={startAll}
              disabled={readyCount === 0 || running > 0}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-40"
            >
              {running > 0 ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              {running > 0 ? `转换中（${running}）` : `开始转换（${readyCount}）`}
            </button>

            <button
              type="button"
              onClick={downloadAll}
              disabled={doneCount === 0}
              className="border-border hover:bg-accent inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm disabled:opacity-40"
            >
              <Download className="size-3.5" />
              全部下载（{doneCount}）
            </button>

            <button
              type="button"
              onClick={clearFinished}
              disabled={doneCount === 0}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm disabled:opacity-40"
            >
              <Trash2 className="size-3.5" />
              清除已完成
            </button>

            {blocked > 0 && (
              <span className="text-muted-foreground ml-auto text-xs">
                {blocked} 个文件没有可选的目标格式
              </span>
            )}
          </div>

          <ul className="mt-4 space-y-3">
            {files.map((entry) => (
              <FileCard key={entry.id} entry={entry} />
            ))}
          </ul>
        </>
      )}

      {files.length === 0 && (
        <section className="mt-10">
          <h2 className="mb-2 text-sm font-medium">这个工具不会替你做的事</h2>
          <ul className="text-muted-foreground space-y-1.5 text-xs leading-relaxed">
            <li>· 不会把音频变成视频——那需要凭空发明画面，那是创作，不是转换。</li>
            <li>· 不会把一张静图拉成动图或视频——缺少的帧不会凭空出现。</li>
            <li>· 不会缩放分辨率、裁剪画面、调整帧率——那些是编辑，不是转换。</li>
          </ul>
          <p className="text-muted-foreground mt-3 text-xs">
            帮你做这些决定很容易，但那样你拿到的就不是你以为的东西了。
          </p>
        </section>
      )}

      <footer className="text-muted-foreground border-border mt-10 flex items-center gap-1.5 border-t pt-5 text-xs">
        <ShieldCheck className="size-3.5 shrink-0" />
        没有上传，没有服务器，没有账户。关掉页面，一切就消失了。
      </footer>
    </div>
  );
}
