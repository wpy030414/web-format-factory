import { useMemo, useState, memo } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Lock,
  X,
  Loader2,
  CircleAlert,
  CircleCheck,
  Link2,
  Unlink,
} from 'lucide-react';
import { FORMATS } from '@/core/registry/formats.ts';
import { MEDIA_CLASS_LABELS } from '@/core/probe/classify.ts';
import { describeProfile, formatSize } from '@/core/probe/profile.ts';
import { IMPOSSIBILITY_COPY } from '@/core/routing/impossibility.ts';
import { planAllTargets, planFor } from '@/core/routing/resolve.ts';
import type { FormatId, ImpossibilityReason } from '@/core/types.ts';
import type { JobPhase, JobProgress } from '@/engines/types.ts';
import { resultFiles, resolveChoice, type FileEntry } from '@/state/store.ts';
import { useStore } from '@/state/store.ts';
import { canSaveToFolder, saveFiles } from '@/lib/save.ts';
import { canShareFiles, shareFiles } from '@/lib/share.ts';
import {
  DownloadButton,
  FidelityBadge,
  LossList,
  ShareButton,
  SpeedBadge,
} from './fidelity-badge.tsx';
import { ParamPanel } from './param-panel.tsx';
import { TargetPicker } from './target-picker.tsx';

/** What a phase means when the engine gives no wording of its own. */
const PHASE_LABELS: Record<JobPhase, string> = {
  'loading-engine': '正在加载引擎',
  probing: '正在读取',
  decoding: '正在解码',
  encoding: '正在编码',
  muxing: '正在封装',
  finalizing: '正在收尾',
  verifying: '正在校验',
};

/**
 * What to say while a job runs.
 *
 * Exported so the honesty rules can be unit-tested without a DOM: a percentage may only
 * appear when the engine actually reported one, a frame count when it actually reported
 * frames, and the reason a bar is indeterminate is never invented. The old copy claimed
 * 「流复制，无法预估进度」 for every ratio-less report — but stream copies are the one case
 * that *does* report a ratio, and the engines that leave it undefined (the image stack,
 * frames→video, Live Photo's phase markers) are not stream copies at all.
 */
export function progressCaption(progress: JobProgress | undefined, copying: boolean): string {
  if (!progress) return '转换中…';

  const pct = progress.ratio === undefined ? null : Math.round(progress.ratio * 100);
  if (pct !== null) {
    // The engine's own label wins when it has one — it knows which engine is running.
    if (progress.label) return `${progress.label} ${pct}%`;
    return copying ? `无损复制中 ${pct}%` : `转换中 ${pct}%`;
  }

  if (progress.frames) {
    return progress.frames.total > 0
      ? `正在取帧 ${progress.frames.done} / ${progress.frames.total}`
      : `正在取帧（已 ${progress.frames.done} 帧）`;
  }

  if (progress.label) return `${progress.label}…`;
  return `${PHASE_LABELS[progress.phase]}…`;
}

export const FileCard = memo(function FileCard({ entry }: { entry: FileEntry }) {
  const setTarget = useStore((s) => s.setTarget);
  const removeFile = useStore((s) => s.removeFile);
  const acknowledge = useStore((s) => s.acknowledge);
  const setParam = useStore((s) => s.setParam);
  const unpair = useStore((s) => s.unpair);
  const pairManually = useStore((s) => s.pairManually);
  const downloadDrained = useStore((s) => s.downloadDrained);
  const allFiles = useStore((s) => s.files);
  const caps = useStore((s) => s.caps);
  const batch = useStore((s) => s.batch);
  const drainMode = useStore((s) => s.drainMode);
  const [showImpossible, setShowImpossible] = useState(false);

  const plans = useMemo(
    () => (entry.profile ? planAllTargets(entry.profile, caps) : []),
    [entry.profile, caps],
  );
  const feasible = plans.filter((p) => p.feasible);
  const impossible = plans.filter((p) => !p.feasible);
  // Parameters are part of the plan, not decoration on top of it: asking for a specific
  // codec or quality turns a lossless container change into a re-encode, and the verdict
  // has to move with the settings that caused it.
  const { target, params } = resolveChoice(entry, batch);
  const active = entry.profile && target ? planFor(entry.profile, target, caps, params) : null;

  // Several targets usually fail for the same reason — an audio file cannot become a
  // video, a GIF, or a Live Photo, and listing that sentence six times buries the one
  // entry that says something different. Group by reason, name the targets once.
  const impossibleGroups = useMemo(() => {
    const byReason = new Map<string, FormatId[]>();
    for (const p of impossible) {
      const reason = p.impossibility!.reason;
      byReason.set(reason, [...(byReason.get(reason) ?? []), p.target]);
    }
    return [...byReason.entries()] as Array<[ImpossibilityReason, FormatId[]]>;
  }, [impossible]);

  const busy = entry.status === 'running' || entry.status === 'queued';

  /**
   * Loose videos this still could be joined to.
   *
   * Read from the whole list rather than passed in, because the answer is a property of
   * the list — it changes as other cards are added, paired or removed — and a card that
   * only knew about itself would offer a pairing that no longer applies.
   */
  const pairCandidates = useMemo(
    () =>
      entry.profile?.mediaClass === 'still-image' && !entry.paired
        ? allFiles.filter(
            (f) =>
              f.id !== entry.id &&
              !f.paired &&
              f.status === 'ready' &&
              (f.profile?.container === 'isobmff-mov' ||
                f.profile?.container === 'isobmff-mp4') &&
              (f.profile?.videoTracks.length ?? 0) > 0,
          )
        : [],
    [allFiles, entry.id, entry.profile?.mediaClass, entry.paired],
  );

  return (
    <li
      className="border-border bg-card rounded-xl border p-4"
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' }}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{entry.file.name}</span>
            {entry.status === 'probing' && (
              <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                <Loader2 className="size-3 animate-spin" /> 识别中
              </span>
            )}
            {entry.profile && (
              <span
                data-testid="media-class"
                className="text-muted-foreground rounded border border-border px-1.5 py-0.5 text-xs"
              >
                {MEDIA_CLASS_LABELS[entry.profile.mediaClass]}
              </span>
            )}
          </div>

          <p className="text-muted-foreground mt-0.5 font-mono text-xs">
            {formatSize(entry.file.size)}
            {entry.profile ? ` · ${describeProfile(entry.profile)}` : ''}
          </p>
        </div>

        <button
          type="button"
          onClick={() => removeFile(entry.id)}
          disabled={busy}
          aria-label={`移除 ${entry.file.name}`}
          className="text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          <X className="size-4" />
        </button>
      </div>

      {/*
        Say how the two halves were matched. An identifier match is evidence, a filename
        match is a guess, and a user deciding whether to trust the pairing deserves to
        know which one they got — including when they are the one who said so.
      */}
      {entry.paired && (
        <div className="mt-2 flex items-start justify-between gap-3">
          <p
            data-testid="pairing-note"
            className="text-muted-foreground flex items-start gap-1.5 text-xs"
          >
            <Link2 className="mt-0.5 size-3 shrink-0" />
            <span>
              已把 <span className="text-foreground">{entry.paired.still.name}</span> 与{' '}
              <span className="text-foreground">{entry.paired.video.name}</span> 合成一个 Live
              Photo
              {entry.paired.matchedBy === 'identifier'
                ? '（两者携带相同的配对标识）'
                : entry.paired.matchedBy === 'manual'
                  ? '（由你指定）'
                  : '（按文件名配对，未能确认标识）'}
              。
            </span>
          </p>

          {/*
            Unpairing has to be reachable, and it is the reason the two originals are kept
            rather than only their names: a filename match is a guess, and a guess the user
            cannot undo is worse than no pairing at all. It also has to be here rather than
            in a menu — the moment you realise the pairing is wrong is the moment you are
            reading the sentence that says what it paired.
          */}
          <button
            type="button"
            data-testid="unpair"
            disabled={busy}
            onClick={() => void unpair(entry.id)}
            className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 text-xs disabled:opacity-40"
          >
            <Unlink className="size-3" />
            拆开
          </button>
        </div>
      )}

      {/*
        Pairing by hand, for the two files the automatic pass could not match: identifiers
        that disagree and names that differ. Offered only where it can work — a still image
        that is not already spoken for, with at least one loose video to join it to.
      */}
      {!entry.paired && entry.profile?.mediaClass === 'still-image' && pairCandidates.length > 0 && (
        <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <Link2 className="size-3 shrink-0" />
          <span>与视频合成 Live Photo：</span>
          {pairCandidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              data-testid={`pair-with-${candidate.id}`}
              disabled={busy}
              onClick={() => void pairManually(entry.id, candidate.id)}
              className="border-border hover:bg-accent text-foreground rounded border px-1.5 py-0.5 disabled:opacity-40"
            >
              {candidate.file.name}
            </button>
          ))}
        </div>
      )}

      {/* An unidentifiable file gets an explanation, not an empty picker. */}
      {entry.profile?.mediaClass === 'unknown' && (
        <p className="text-muted-foreground mt-3 flex items-start gap-1.5 text-xs">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          {entry.profile.unknownReason ?? '无法识别这个文件。'}
        </p>
      )}

      {entry.profile && entry.profile.mediaClass !== 'unknown' && (
        <>
          {/*
            In batch mode the choice lives in one card below the toolbar. Rendering a second
            picker here would be a second answer to the same question — and two buttons with
            the same label on screen at once, which a user (or a test) cannot tell apart.
          */}
          {!batch.enabled && (
            <>
              <TargetPicker
                feasible={feasible.map((p) => p.target)}
                current={entry.target}
                familyOf={(t) => FORMATS[t].family}
                onPick={(t) => setTarget(entry.id, t)}
                disabled={busy}
              />

              {/*
                Parameters come before the verdict. The verdict is a consequence of these
                settings, so reading it after them is the natural order — and it means the
                summary is the last thing seen before Convert.
              */}
              {entry.target && (
                <ParamPanel
                  target={entry.target}
                  values={entry.params ?? {}}
                  onChange={(key, value) => setParam(entry.id, key, value)}
                  disabled={busy || entry.status === 'done'}
                />
              )}
            </>
          )}

          {active && <PlanSummary plan={active} />}

          {/*
            A file the shared target cannot serve has nowhere else to say so once the picker
            is gone. This is not a fallback — nothing is being routed around — it is the same
            refusal the per-file list would have given, in one line instead of a disclosure.
          */}
          {batch.enabled && batch.target && active && !active.feasible && (
            <p
              data-testid="batch-mismatch"
              className="text-muted-foreground mt-3 flex items-start gap-1.5 text-xs"
            >
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                本批次的共享目标「{FORMATS[batch.target].label}」不适用于这个文件，它不会参与转换：
                {active.impossibility
                  ? IMPOSSIBILITY_COPY[active.impossibility.reason].body({
                      reason: active.impossibility.reason,
                      alternatives: [],
                    })
                  : '这台机器上没有可用的转换路径。'}
              </span>
            </p>
          )}

          {active?.needsAcknowledgement && entry.status !== 'done' && (
            <label className="border-destructive/40 bg-destructive/5 mt-3 flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-xs">
              <input
                type="checkbox"
                checked={entry.acknowledged ?? false}
                onChange={(e) => acknowledge(entry.id, e.target.checked)}
                className="mt-0.5"
              />
              <span>我明白以上标红的内容不可恢复，确认继续。</span>
            </label>
          )}

          {impossible.length > 0 && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setShowImpossible((v) => !v)}
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
              >
                {showImpossible ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
                {impossible.length} 种格式不可选，查看理由
              </button>

              {showImpossible && (
                <ul className="mt-2 space-y-1.5">
                  {impossibleGroups.map(([reason, targets]) => {
                    const copy = IMPOSSIBILITY_COPY[reason];
                    return (
                      <li key={reason} className="flex items-start gap-1.5 text-xs">
                        <Lock className="text-muted-foreground mt-0.5 size-3 shrink-0" />
                        <span className="text-muted-foreground">
                          <span className="text-foreground" title={copy.title}>
                            {targets.map((t) => FORMATS[t].label).join('、')}：
                          </span>
                          {copy.body({ reason, alternatives: [] })}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      <StatusLine entry={entry} copying={active?.did === 'transmux'} drainMode={drainMode} downloadDrained={downloadDrained} />
    </li>
  );
});

function PlanSummary({ plan }: { plan: ReturnType<typeof planFor> }) {
  if (!plan.feasible) return null;
  return (
    <div data-testid="plan-summary" className="border-border mt-3 rounded-lg border p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {plan.fidelity && <FidelityBadge fidelity={plan.fidelity} />}
        {plan.did && <SpeedBadge did={plan.did} />}
        {plan.needsAcknowledgement && (
          <span className="text-destructive inline-flex items-center gap-1 text-xs font-medium">
            <CircleAlert className="size-3" /> 需确认
          </span>
        )}
      </div>
      <LossList items={plan.losses} />
    </div>
  );
}

function StatusLine({
  entry,
  copying,
  drainMode,
  downloadDrained,
}: {
  entry: FileEntry;
  copying: boolean;
  drainMode: string;
  downloadDrained: (id: string) => Promise<void>;
}) {
  if (entry.status === 'running') {
    const pct =
      entry.progress?.ratio === undefined ? null : Math.round(entry.progress.ratio * 100);
    return (
      <div className="mt-3">
        <div
          data-testid="progress"
          className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
        >
          {pct === null ? (
            // Indeterminate is a real state — the engine has not reported a ratio, and a
            // fabricated percentage would be a lie. But the reason is only ever the one
            // the engine gave us; the caption says which.
            <div className="bg-primary h-full w-1/3 animate-pulse rounded-full" />
          ) : (
            <div
              className="bg-primary h-full rounded-full transition-[width]"
              style={{ width: `${pct}%` }}
            />
          )}
        </div>
        <p data-testid="progress-caption" className="text-muted-foreground mt-1 text-xs">
          {progressCaption(entry.progress, copying)}
        </p>
      </div>
    );
  }

  if (entry.status === 'queued') {
    return <p className="text-muted-foreground mt-3 text-xs">排队中…</p>;
  }

  if (entry.status === 'done' && entry.result) {
    const primary = entry.result.outputs[0];
    const totalSize = entry.result.outputs.reduce((s, o) => s + o.size, 0);
    const multi = entry.result.outputs.length > 1;
    const hasBlobs = entry.result.outputs.some((o) => o.blob);

    // Drained results: blobs are released, card shows a lighter state.
    if (entry.drained && !hasBlobs) {
      if (drainMode === 'folder') {
        return (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-fidelity-lossless inline-flex items-center gap-1 text-xs">
              <CircleCheck className="size-3" /> 完成 · {formatSize(totalSize)}
            </span>
            <span className="text-muted-foreground text-xs">已保存至目录</span>
          </div>
        );
      }
      // IDB mode: blob is in IndexedDB, can be downloaded.
      return (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-fidelity-lossless inline-flex items-center gap-1 text-xs">
            <CircleCheck className="size-3" /> 完成 · {formatSize(totalSize)}
          </span>
          <DownloadButton
            onClick={() => void downloadDrained(entry.id)}
            name={
              multi
                ? canSaveToFolder()
                  ? `${entry.result.outputs.length} 个文件`
                  : `${entry.result.outputs.length} 个文件（zip）`
                : primary!.name
            }
          />
          <span className="text-muted-foreground text-xs">已暂存</span>
        </div>
      );
    }

    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-fidelity-lossless inline-flex items-center gap-1 text-xs">
          <CircleCheck className="size-3" /> 完成 · {formatSize(totalSize)}
        </span>
        <DownloadButton
          onClick={() => void saveFiles(resultFiles(entry.result!))}
          // Named for what actually lands. With multiple files it is either a folder the
          // user picks or a `.zip` — and never "点击两次各下各的", which browsers throttle
          // and then say nothing about (src/lib/save.ts).
          name={
            multi
              ? canSaveToFolder()
                ? `${entry.result.outputs.length} 个文件`
                : `${entry.result.outputs.length} 个文件（zip）`
              : primary!.name
          }
        />
        {canShareFiles(resultFiles(entry.result)) && (
          <ShareButton onClick={() => void shareFiles(resultFiles(entry.result!))} />
        )}
      </div>
    );
  }

  if (entry.status === 'error') {
    return (
      <p className="text-destructive mt-3 flex items-start gap-1.5 text-xs">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
        {entry.error}
      </p>
    );
  }

  if (entry.status === 'cancelled') {
    return <p className="text-muted-foreground mt-3 text-xs">已取消</p>;
  }

  return null;
}

