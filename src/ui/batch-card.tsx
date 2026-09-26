import { useMemo } from 'react';
import { FORMATS } from '@/core/registry/formats.ts';
import { offeredTargets, useStore } from '@/state/store.ts';
import { ParamPanel } from './param-panel.tsx';
import { TargetPicker } from './target-picker.tsx';

/**
 * The one conversion target the whole batch shares.
 *
 * Shown only while batch mode is on. It exists because batch use is the normal use: the
 * per-file cards ask the same question once per file, and a batch of ten is a batch of ten
 * identical answers.
 *
 * The targets offered are the union of what each file can reach, never an intersection — a
 * batch holding an image and a video has no target in common, and offering nothing would
 * make the honest-looking choice the useless one. A file the chosen target cannot serve
 * says so on its own card rather than being quietly dropped or silently re-routed.
 */
export function BatchCard() {
  const files = useStore((s) => s.files);
  const caps = useStore((s) => s.caps);
  const batch = useStore((s) => s.batch);
  const running = useStore((s) => s.running);
  const setBatchTarget = useStore((s) => s.setBatchTarget);
  const setBatchParam = useStore((s) => s.setBatchParam);

  const feasible = useMemo(() => offeredTargets(files, caps), [files, caps]);

  // Said plainly rather than inferred from the buttons: a union looks exactly like a
  // single file's list until you notice a target only one of the files can use.
  const mixed = useMemo(() => {
    const classes = new Set(
      files.filter((f) => f.profile && f.profile.mediaClass !== 'unknown').map((f) => f.profile!.mediaClass),
    );
    return classes.size > 1;
  }, [files]);

  return (
    <section
      data-testid="batch-card"
      aria-labelledby="batch-card-title"
      className="border-border bg-card mt-4 rounded-xl border p-4"
    >
      <h2 id="batch-card-title" className="text-sm font-medium">
        转换目标（批量）
      </h2>
      <p className="text-muted-foreground mt-0.5 text-xs">
        以下设置适用于全部 {files.length} 个文件。
        {mixed
          ? '这批文件类别不一，下面列出的是各文件可达目标的并集；用不上这个目标的文件会各自说明。'
          : ''}
      </p>

      <TargetPicker
        feasible={feasible}
        current={batch.target}
        familyOf={(t) => FORMATS[t].family}
        onPick={setBatchTarget}
        disabled={running > 0}
      />

      {batch.target && (
        <ParamPanel
          target={batch.target}
          values={batch.params}
          onChange={setBatchParam}
          disabled={running > 0}
        />
      )}
    </section>
  );
}
