import { useMemo, useState } from 'react';
import { Check, Lock, ArrowRightLeft, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils.ts';
import { ALL_FORMAT_IDS, FORMATS } from '@/core/registry/formats.ts';
import { verdictFor } from '@/core/routing/transitions.ts';
import { IMPOSSIBILITY_COPY } from '@/core/routing/impossibility.ts';
import type { FormatId, MediaClass } from '@/core/types.ts';

/** Source classes a person can actually drop in. `unknown` is a runtime outcome, not a pick. */
const SOURCE_CLASSES: ReadonlyArray<{ id: MediaClass; label: string; hint: string }> = [
  { id: 'video', label: 'Video', hint: 'MP4, MOV, MKV, WebM' },
  { id: 'animated-image', label: 'Animated image', hint: 'GIF, animated WebP, APNG' },
  { id: 'still-image', label: 'Still image', hint: 'JPEG, PNG, WebP, HEIC' },
  { id: 'audio', label: 'Audio', hint: 'MP3, M4A, FLAC, WAV, OGG, AAC' },
  { id: 'live-photo', label: 'Live Photo', hint: 'Apple or Google' },
];

export function App() {
  const [source, setSource] = useState<MediaClass>('video');

  const rows = useMemo(
    () =>
      ALL_FORMAT_IDS.map((target) => ({
        target,
        spec: FORMATS[target],
        verdict: verdictFor(source, target),
      })),
    [source],
  );

  const reachable = rows.filter((r) => r.verdict.kind !== 'impossible').length;

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Web Format Factory</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl text-sm leading-relaxed">
          Every conversion happens on this device. Files are never uploaded anywhere.
          Below is the full conversion matrix — including the conversions this tool
          deliberately refuses to perform, and why.
        </p>
      </header>

      <section className="mb-6">
        <div className="mb-3 flex items-center gap-2">
          <ArrowRightLeft className="text-muted-foreground size-4" />
          <span className="text-sm font-medium">What are you converting from?</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {SOURCE_CLASSES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSource(c.id)}
              aria-pressed={source === c.id}
              className={cn(
                'rounded-lg border px-3 py-2 text-left transition-colors',
                source === c.id
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'hover:bg-accent border-border',
              )}
            >
              <div className="text-sm font-medium">{c.label}</div>
              <div
                className={cn(
                  'text-xs',
                  source === c.id ? 'text-primary-foreground/70' : 'text-muted-foreground',
                )}
              >
                {c.hint}
              </div>
            </button>
          ))}
        </div>
      </section>

      <div className="text-muted-foreground mb-3 flex items-center gap-2 text-xs">
        <ShieldCheck className="size-3.5" />
        <span>
          {reachable} of {rows.length} targets are reachable from {labelOf(source)}
        </span>
      </div>

      <ul className="grid gap-2 sm:grid-cols-2">
        {rows.map(({ target, spec, verdict }) => (
          <li
            key={target}
            className={cn(
              'rounded-lg border p-3',
              verdict.kind === 'impossible' ? 'border-border/60 opacity-60' : 'border-border',
            )}
          >
            <div className="flex items-center gap-2">
              {verdict.kind === 'impossible' ? (
                <Lock className="text-muted-foreground size-4 shrink-0" />
              ) : (
                <Check className="text-fidelity-lossless size-4 shrink-0" />
              )}
              <span className="text-sm font-medium">{spec.label}</span>
              <span className="text-muted-foreground ml-auto font-mono text-xs">
                .{spec.extension}
              </span>
            </div>

            {verdict.kind === 'project' && (
              <p className="text-muted-foreground mt-1.5 text-xs">
                Needs a projection step ({verdict.projector})
              </p>
            )}

            {verdict.kind === 'impossible' && (
              <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
                <span className="text-foreground font-medium">
                  {IMPOSSIBILITY_COPY[verdict.reason].title}.
                </span>{' '}
                {IMPOSSIBILITY_COPY[verdict.reason].body({
                  reason: verdict.reason,
                  alternatives: [],
                })}
              </p>
            )}

            {spec.note && verdict.kind !== 'impossible' && (
              <p className="text-muted-foreground mt-1.5 text-xs">{spec.note}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function labelOf(cls: MediaClass): string {
  return SOURCE_CLASSES.find((c) => c.id === cls)?.label.toLowerCase() ?? cls;
}

export type { FormatId };
