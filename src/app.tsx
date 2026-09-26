import { useCallback, useEffect, useState } from 'react';
import { Play, Download, Trash2, Loader2 } from 'lucide-react';
import { isActionable, isAwaitingAck, isBlocked, useStore } from '@/state/store.ts';
import { BatchCard } from '@/ui/batch-card.tsx';
import { Dropzone } from '@/ui/dropzone.tsx';
import { FileCard } from '@/ui/file-card.tsx';
import { CapabilitiesPage } from '@/ui/capabilities.tsx';
import { ForceRefresh } from '@/ui/force-refresh.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { GithubMark } from '@/ui/github-mark.tsx';
import { Activity } from 'lucide-react';

/**
 * A one-line router.
 *
 * Hash-based on purpose: a path-based route would need a server rewrite rule on every
 * host this is deployed to, and the diagnostic page must not be the thing that breaks
 * on a misconfigured server — it is what you visit when something is broken.
 */
function useRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export function App() {
  const route = useRoute();
  if (route === '#/capabilities') return <CapabilitiesPage />;
  return <Converter />;
}

function Converter() {
  const files = useStore((s) => s.files);
  const running = useStore((s) => s.running);
  const caps = useStore((s) => s.caps);
  const addFiles = useStore((s) => s.addFiles);
  const startAll = useStore((s) => s.startAll);
  const downloadAll = useStore((s) => s.downloadAll);
  const clearFinished = useStore((s) => s.clearFinished);
  const measureCapabilities = useStore((s) => s.measureCapabilities);

  // The one capability that has to be measured rather than read. It only ever *closes*
  // routes the user has not chosen a codec for yet, so nothing flashes: the picker is not
  // on screen until a file has been dropped, which takes far longer than this does.
  useEffect(() => {
    measureCapabilities();
  }, [measureCapabilities]);

  const onFiles = useCallback(
    (incoming: File[]) => {
      void addFiles(incoming);
    },
    [addFiles],
  );

  const batch = useStore((s) => s.batch);
  const setBatch = useStore((s) => s.setBatch);

  // The counts come from the store's own predicates — the very ones `startAll` queues
  // with — so the button can never promise work the loop then skips. A count that
  // overstates is a silent no-op, which is worse than a disabled button.
  const readyCount = files.filter((f) => isActionable(f, caps, batch)).length;
  const doneCount = files.filter((f) => f.status === 'done').length;
  // Kept separate so the UI can explain the wait instead of just refusing.
  const awaitingAck = files.filter((f) => isAwaitingAck(f, caps, batch)).length;
  const blocked = files.filter((f) => isBlocked(f, batch)).length;

  return (
    <div className="mx-auto max-w-3xl px-5 py-10">
      <header className="mb-7 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Web Format Factory</h1>
        {/*
          A switch, not a checkbox, and the distinction is load-bearing rather than
          cosmetic: `role="switch"` keeps this control out of `getByRole('checkbox')`,
          which is how the acknowledgement box on a card is found. A plain checkbox here
          would make that lookup ambiguous the moment a file needs acknowledging.
        */}
        <div className="flex shrink-0 items-center gap-2 text-sm">
          <label
            htmlFor="batch-switch"
            className="text-muted-foreground cursor-pointer select-none"
          >
            批量
          </label>
          <Switch
            id="batch-switch"
            data-testid="batch-switch"
            checked={batch.enabled}
            onCheckedChange={setBatch}
            aria-label="批量"
          />
        </div>
      </header>

      <Dropzone onFiles={onFiles} />

      {files.length > 0 && (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-2 py-3">
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

            {awaitingAck > 0 && (
              <span className="text-muted-foreground text-xs">
                {awaitingAck} 个文件等待确认
              </span>
            )}

            {blocked > 0 && (
              <span className="text-muted-foreground ml-auto text-xs">
                {blocked} 个文件没有可选的目标格式
              </span>
            )}
          </div>

          {/* Sits between the toolbar and the list, never inside it: the list's children
              are <li> elements, and a section among them would be invalid markup. */}
          {batch.enabled && <BatchCard />}

          <ul className="mt-4 space-y-3">
            {files.map((entry) => (
              <FileCard key={entry.id} entry={entry} />
            ))}
          </ul>
        </>
      )}

      {/* 1rem between entries, not the couple of pixels a tight footer usually gets: two
          separate actions sitting that close read as one phrase. */}
      <footer className="text-muted-foreground border-border mt-10 flex items-center gap-4 border-t pt-5 text-xs">
        <a
          href="#/capabilities"
          className="hover:text-foreground inline-flex items-center gap-1"
        >
          <Activity className="size-3" />
          本机能力诊断
        </a>
        {/* Next to the diagnostics entry, because it is the step before that page: what the
            report shows is partly decided by caches, and a stale one is indistinguishable
            from a real answer once you are looking at it. */}
        <ForceRefresh />
        <a
          href="https://github.com/wpy030414/web-format-factory"
          target="_blank"
          rel="noreferrer noopener"
          className="hover:text-foreground ml-auto inline-flex items-center gap-1"
        >
          <GithubMark className="size-3.5 shrink-0" />
          项目仓库
        </a>
      </footer>
    </div>
  );
}
