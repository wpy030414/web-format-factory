import { useCallback, useEffect, useState } from 'react';
import { Play, Download, Trash2, Loader2, FolderOpen, FolderX } from 'lucide-react';
import { isActionable, isAwaitingAck, isBlocked, useStore } from '@/state/store.ts';
import { canSaveToFolder } from '@/lib/save.ts';
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
  // The heading doubles as a version readout: one click shows the commit the running
  // bundle was built from, one more puts the name back. Local state on purpose — this
  // is a peek, not a mode, and it should not survive anything.
  const [hashShown, setHashShown] = useState(false);

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
  const drainMode = useStore((s) => s.drainMode);
  const pickDrainFolder = useStore((s) => s.pickDrainFolder);
  const clearDrainFolder = useStore((s) => s.clearDrainFolder);
  const enableIdbDrain = useStore((s) => s.enableIdbDrain);

  // When FSAA is missing, IDB drain is where results go to keep memory flat — and a
  // fallback the user must opt into is not a fallback, it is a trap for whoever skipped
  // the button. So it switches itself on with the first file. Gated on a file (not the
  // page load) so an empty session still opens nothing; if IndexedDB refuses to open
  // (private browsing), it stays in 'none' — blobs in memory beat a promise to drain
  // that cannot be kept.
  useEffect(() => {
    if (canSaveToFolder() || files.length === 0 || drainMode !== 'none') return;
    enableIdbDrain().catch(() => {});
  }, [files.length, drainMode, enableIdbDrain]);

  // The counts come from the store's own predicates — the very ones `startAll` queues
  // with — so the button can never promise work the loop then skips. A count that
  // overstates is a silent no-op, which is worse than a disabled button.
  const readyCount = files.filter((f) => isActionable(f, caps, batch)).length;
  const doneCount = files.filter((f) => f.status === 'done').length;
  // While a batch is in flight, the store's `running` is the concurrency counter — it
  // saturates at MAX_CONCURRENT and then never moves, which reads as a frozen number.
  // What the user is watching for is how much of the batch is left, so count the work,
  // not the workers: queued + running is exactly the set that has not finished yet.
  const pendingCount = files.filter((f) => f.status === 'queued' || f.status === 'running').length;
  // Kept separate so the UI can explain the wait instead of just refusing.
  const awaitingAck = files.filter((f) => isAwaitingAck(f, caps, batch)).length;
  const blocked = files.filter((f) => isBlocked(f, batch)).length;

  return (
    <div className="mx-auto max-w-3xl px-5 py-10">
      <header className="mb-7 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {/*
            A real button so the peek is keyboard-reachable, not a click handler on a
            heading. Absent entirely when the bundle has no hash to show (built outside
            a git checkout): a control that reveals nothing is a lie, not a fallback.
          */}
          {__COMMIT_HASH__ ? (
            <button
              type="button"
              onClick={() => setHashShown((v) => !v)}
              title="点击显示构建 commit"
              className="cursor-pointer"
            >
              {hashShown ? __COMMIT_HASH__ : 'Web Format Factory'}
            </button>
          ) : (
            'Web Format Factory'
          )}
        </h1>
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
            {/* 保存目录：FSAA 可用时显示，让大文件量场景产物直接落地 */}
            {canSaveToFolder() && files.some((f) => f.status === 'ready') && drainMode !== 'folder' && (
              <button
                type="button"
                onClick={() => void pickDrainFolder()}
                className="border-border hover:bg-accent inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
              >
                <FolderOpen className="size-3.5" />
                选择保存目录
              </button>
            )}
            {/* FSAA unavailable → IDB drain is already on (see the effect above); there is
                nothing left to ask the user, so no button here. */}
            {drainMode === 'folder' && (
              <>
                <span className="text-fidelity-lossless inline-flex items-center gap-1 text-xs">
                  <FolderOpen className="size-3" />
                  已选保存目录
                </span>
                <button
                  type="button"
                  onClick={clearDrainFolder}
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
                >
                  <FolderX className="size-3" />
                  取消
                </button>
              </>
            )}

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
              {running > 0 ? `转换中（${pendingCount}）` : `开始转换（${readyCount}）`}
            </button>

            {drainMode === 'folder' ? (
              <span className="text-muted-foreground inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm">
                <FolderOpen className="size-3.5" />
                已保存（{doneCount}）
              </span>
            ) : (
              // The count is finished tasks, not "done with blob still in memory": in IDB
              // drain mode the blob is released on purpose, and `downloadAll` reads it back
              // on demand — a count that drops to zero there would disable a working button
              // and deny work the loop can actually do.
              <button
                type="button"
                onClick={downloadAll}
                disabled={doneCount === 0}
                className="border-border hover:bg-accent inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm disabled:opacity-40"
              >
                <Download className="size-3.5" />
                全部下载（{doneCount}）
              </button>
            )}

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

          <ul className="mt-4 max-h-[70vh] space-y-3 overflow-y-auto">
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
