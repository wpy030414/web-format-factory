import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * 强制刷新：丢掉本站自己留下的缓存，然后重新加载。
 *
 * 放在页脚「本机能力诊断」旁边，因为这是同一条路上的两步：诊断页报告的全是浏览器
 * 给了什么，而浏览器给什么有一部分是缓存说了算——一个还没换掉的 Service Worker、
 * 一份过期的引擎 wasm，都会让那一页显示的东西与服务器上的不一致，而且从那一页上
 * 看不出区别。「明明已经重新部署过了，这里还是老样子」的时候，先按这个再去看。
 *
 * 弹窗而不是就地展开：要讲的话不长，但也不少——清什么、不清什么、代价是什么——把
 * 这些塞进页脚会把页脚撑变形，而页脚是给入口用的，不是给说明用的。
 *
 * 代价写在脸上、再问一次：清掉缓存意味着下一次转码要重新下载那个约 31MB 的兜底引
 * 擎。所以它不叫「刷新」，也不在一次点击里发生。
 *
 * 页面碰不到浏览器的 HTTP 缓存——那是浏览器自己的，没有任何 Web API 能清。能清的
 * 是 Cache Storage 与 Service Worker 注册：恰好就是本站能自己留下来的两样东西。
 */
export function ForceRefresh() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<'asking' | 'working' | 'done' | 'failed'>('asking');
  const [cleared, setCleared] = useState<Cleared | null>(null);
  const [error, setError] = useState('');

  // Once the caches are gone there is no way back, so the dialog stops accepting input —
  // Escape and the close button included — rather than letting the user half-cancel it.
  const busy = phase === 'working' || phase === 'done';

  async function run() {
    setPhase('working');
    try {
      const result = await clearSiteCaches();
      setCleared(result);
      setPhase('done');
      // One beat to read the outcome, then reload — including when nothing was found, since
      // picking up a freshly deployed shell is the ordinary reason to press this at all.
      setTimeout(() => location.reload(), 900);
    } catch (cause) {
      // Never reload on a failure. The dialog that stays is the one that can say what broke.
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase('failed');
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="force-refresh"
        onClick={() => {
          setPhase('asking');
          setOpen(true);
        }}
        className="hover:text-foreground inline-flex shrink-0 items-center gap-1"
      >
        <RefreshCw className="size-3" />
        强制刷新
      </button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent data-testid="force-refresh-dialog">
          <DialogHeader>
            <DialogTitle>强制刷新</DialogTitle>
            <DialogDescription>清空本站自己留下的缓存，然后重新加载。</DialogDescription>
          </DialogHeader>

          {phase === 'failed' ? (
            <p className="text-destructive text-xs" data-testid="force-refresh-error">
              清除失败：{error}
            </p>
          ) : (
            <ul className="text-muted-foreground space-y-1.5 text-xs">
              <li>会清掉：Cache Storage 的全部缓存，以及 Service Worker 的注册。</li>
              <li>
                清不掉：浏览器的 HTTP 缓存——那是浏览器自己的，任何页面都碰不到它。
              </li>
              <li className="text-foreground">
                代价：下次转码要重新下载约 31MB 的兜底引擎。
              </li>
            </ul>
          )}

          {phase === 'done' && (
            <p className="text-xs" data-testid="force-refresh-done">
              {describe(cleared)}，正在重新加载…
            </p>
          )}

          <DialogFooter>
            {/* `justify-center` on both: the footer stacks them full-width on a narrow
                screen, and a flex child packs to the start — which reads as text that
                fell to the left edge rather than a centred label. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs disabled:opacity-40"
            >
              取消
            </button>
            <button
              type="button"
              data-testid="force-refresh-go"
              disabled={busy}
              onClick={() => void run()}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-40"
            >
              {phase === 'working' ? (
                <>
                  <Loader2 className="size-3 animate-spin" /> 正在清除…
                </>
              ) : (
                '确认清除'
              )}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface Cleared {
  caches: number;
  workers: number;
}

/** Delete everything this origin cached, and stop whatever would put it back. */
async function clearSiteCaches(): Promise<Cleared> {
  // Cache Storage first: every cache this origin owns, whatever named it — the fallback
  // engine's wasm lives in one of them on a plain HTTP visit, and a stale copy of it is
  // exactly the kind of thing that makes the report next door disagree with the server.
  const names = typeof caches === 'undefined' ? [] : await caches.keys();
  await Promise.all(names.map((name) => caches.delete(name)));

  // Service workers second, never the other way round: a live worker would repopulate the
  // caches that were just emptied, and would go on serving the old shell whatever the
  // server now says.
  const registrations = navigator.serviceWorker
    ? await navigator.serviceWorker.getRegistrations()
    : [];
  await Promise.all(registrations.map((registration) => registration.unregister()));

  return { caches: names.length, workers: registrations.length };
}

/** What was actually cleared — which is not always something. */
function describe(cleared: Cleared | null): string {
  if (!cleared) return '没有可清除的缓存';
  const parts: string[] = [];
  if (cleared.caches > 0) parts.push(`${cleared.caches} 份缓存`);
  if (cleared.workers > 0) parts.push(`${cleared.workers} 个 Service Worker`);
  return parts.length > 0 ? `已清除 ${parts.join('、')}` : '没有可清除的缓存';
}
