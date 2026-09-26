import { useMemo } from 'react';
import { cn } from '@/lib/utils.ts';
import { FORMATS } from '@/core/registry/formats.ts';
import type { FormatId } from '@/core/types.ts';

const FAMILY_LABELS: Record<string, string> = {
  image: '图像',
  video: '视频',
  audio: '音频',
  live: 'Live Photo',
};

/**
 * The format buttons, grouped by family.
 *
 * Shared by both modes on purpose: a batch picker that looked or behaved differently from
 * the per-file one would make the switch feel like a different tool rather than the same
 * choice applied to more files.
 */
export function TargetPicker({
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
