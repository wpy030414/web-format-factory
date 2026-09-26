import { useMemo, useState } from 'react';
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
import { cn } from '@/lib/utils.ts';
import { FORMATS } from '@/core/registry/formats.ts';
import { MEDIA_CLASS_LABELS } from '@/core/probe/classify.ts';
import { describeProfile, formatSize } from '@/core/probe/profile.ts';
import { IMPOSSIBILITY_COPY } from '@/core/routing/impossibility.ts';
import { planAllTargets, planFor } from '@/core/routing/resolve.ts';
import type { FormatId, ImpossibilityReason } from '@/core/types.ts';
import { downloadResult, resultFiles, type FileEntry } from '@/state/store.ts';
import { useStore } from '@/state/store.ts';
import { canShareFiles, shareFiles } from '@/lib/share.ts';
import {
  DownloadButton,
  FidelityBadge,
  LossList,
  ShareButton,
  SpeedBadge,
} from './fidelity-badge.tsx';
import { ParamPanel } from './param-panel.tsx';

const FAMILY_LABELS: Record<string, string> = {
  image: '图像',
  video: '视频',
  audio: '音频',
  live: 'Live Photo',
};

export function FileCard({ entry }: { entry: FileEntry }) {
  const setTarget = useStore((s) => s.setTarget);
  const removeFile = useStore((s) => s.removeFile);
  const acknowledge = useStore((s) => s.acknowledge);
  const setParam = useStore((s) => s.setParam);
  const unpair = useStore((s) => s.unpair);
  const pairManually = useStore((s) => s.pairManually);
  const allFiles = useStore((s) => s.files);
  const caps = useStore((s) => s.caps);
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
  const params = entry.params ?? {};
  const active =
    entry.profile && entry.target
      ? planFor(entry.profile, entry.target, caps, params)
      : null;

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
    <li className="border-border bg-card rounded-xl border p-4">
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

          {active && <PlanSummary plan={active} />}

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

      <StatusLine entry={entry} />
    </li>
  );
}

function TargetPicker({
  feasible,
  current,
  familyOf,
  onPick,
  disabled,
}: {
  feasible: FormatId[];
  current: FormatId | null;
  familyOf: (t: FormatId) => string;
  onPick: (t: FormatId) => void;
  disabled: boolean;
}) {
  // Grouped so 17 targets read as a few meaningful clusters rather than a wall.
  const groups = useMemo(() => {
    const map = new Map<string, FormatId[]>();
    for (const t of feasible) {
      const family = familyOf(t);
      const list = map.get(family) ?? [];
      list.push(t);
      map.set(family, list);
    }
    return [...map.entries()];
  }, [feasible, familyOf]);

  return (
    <div className="mt-3 space-y-2">
      {groups.map(([family, targets]) => (
        <div key={family} className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground w-16 shrink-0 text-xs">
            {FAMILY_LABELS[family] ?? family}
          </span>
          {targets.map((t) => (
            <button
              key={t}
              type="button"
              disabled={disabled}
              onClick={() => onPick(t)}
              aria-pressed={current === t}
              className={cn(
                'rounded-md border px-2 py-1 text-xs transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-50',
                current === t
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border hover:bg-accent',
              )}
            >
              {FORMATS[t].label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

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

function StatusLine({ entry }: { entry: FileEntry }) {
  if (entry.status === 'running') {
    const pct = entry.progress === undefined ? null : Math.round(entry.progress * 100);
    return (
      <div className="mt-3">
        <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
          {pct === null ? (
            // Indeterminate is a real state — a stream copy has no known duration, and a
            // fabricated percentage would be a lie.
            <div className="bg-primary h-full w-1/3 animate-pulse rounded-full" />
          ) : (
            <div
              className="bg-primary h-full rounded-full transition-[width]"
              style={{ width: `${pct}%` }}
            />
          )}
        </div>
        <p className="text-muted-foreground mt-1 text-xs">
          {pct === null ? '转换中（流复制，无法预估进度）' : `转换中 ${pct}%`}
        </p>
      </div>
    );
  }

  if (entry.status === 'queued') {
    return <p className="text-muted-foreground mt-3 text-xs">排队中…</p>;
  }

  if (entry.status === 'done' && entry.result) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-fidelity-lossless inline-flex items-center gap-1 text-xs">
          <CircleCheck className="size-3" /> 完成 · {formatSize(entry.result.size)}
        </span>
        <DownloadButton
          onClick={() => downloadResult(entry.result!)}
          // Named honestly when there are two: saving only the still would leave the user
          // with a photograph and no Live Photo, which is exactly the failure this whole
          // route exists to avoid.
          name={entry.result.companion ? '两个文件' : entry.result.name}
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

