import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

/**
 * 强制刷新：丢掉本站自己留下的缓存，然后重新加载。
 *
 * 这一页报告的全是浏览器给了什么，而浏览器给什么有一部分是缓存说了算——一个还没
 * 换掉的 Service Worker、一份过期的引擎 wasm，都会让这里显示的东西和服务器上的不
 * 一致，而且从这一页上看不出区别。「明明已经重新部署过了，这里还是老样子」的时候，
 * 这是第一步。
 *
 * 代价写在脸上、再问一次：清掉缓存意味着下一次转码要重新下载那个约 31MB 的兜底引
 * 擎。所以它不叫「刷新」，也不在一次点击里发生。
 *
 * 页面碰不到浏览器的 HTTP 缓存——那是浏览器自己的，没有任何 Web API 能清。能清的
 * 是 Cache Storage 与 Service Worker 注册：恰好就是本站能自己留下来的两样东西。
 */
export function ForceRefresh() {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'working' | 'done' | 'failed'>('idle');
  const [cleared, setCleared] = useState<Cleared | null>(null);
  const [error, setError] = useState('');

  async function run() {
    setPhase('working');
    try {
      const result = await clearSiteCaches();
      setCleared(result);
      setPhase('done');
      // One beat to read the outcome, then reload — including when nothing was found, since
      // picking up a freshly deployed shell is the ordinary reason to press this at all.
      setTimeout(() => location.reload(), 700);
    } catch (cause) {
      // Never reload on a failure. The page that stays is the one that can say what broke.
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase('failed');
    }
  }

  if (phase === 'working') {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
        <Loader2 className="size-3 animate-spin" /> 正在清除…
      </span>
    );
  }

  if (phase === 'done') {
    return (
      <span className="text-muted-foreground text-xs" data-testid="force-refresh-done">
        {describe(cleared)}，正在重新加载…
      </span>
    );
  }

  if (phase === 'failed') {
    return (
      <span className="text-destructive text-xs" data-testid="force-refresh-error">
        清除失败：{error}
      </span>
    );
  }

  if (phase === 'confirm') {
    return (
      <div className="flex flex-col items-end gap-1.5" data-testid="force-refresh-confirm">
        <p className="text-muted-foreground max-w-xs text-right text-[11px] leading-snug">
          将清空 Cache Storage 与 Service Worker，然后重新加载。下次转码要重新下载兜底引擎。
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPhase('idle')}
            className="text-muted-foreground hover:text-foreground text-xs"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="force-refresh-go"
            onClick={() => void run()}
            className="border-border hover:bg-accent text-foreground rounded border px-1.5 py-0.5 text-xs"
          >
            确认清除
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      data-testid="force-refresh"
      onClick={() => setPhase('confirm')}
      className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 text-xs"
    >
      <RefreshCw className="size-3" />
      强制刷新
    </button>
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
  // exactly the kind of thing that makes this report disagree with the server.
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
