import { useState } from 'react';
import { ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils.ts';
import { FORMATS, type ParamSpec } from '@/core/registry/formats.ts';
import type { FormatId } from '@/core/types.ts';

interface ParamPanelProps {
  target: FormatId;
  values: Readonly<Record<string, unknown>>;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
}

/**
 * The encoding parameters for one target.
 *
 * Rendered from the format's own `ParamSpec` list rather than hand-written per format,
 * so a new format brings its controls with it and the panel cannot drift out of step
 * with what the pipeline actually accepts.
 *
 * Two levels on purpose: the common knobs stay in view, and the ones most people will
 * never touch sit behind a disclosure. Showing all of them at once makes every
 * conversion look complicated, which is how people end up changing settings they do not
 * understand.
 */
export function ParamPanel({ target, values, onChange, disabled }: ParamPanelProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const specs = FORMATS[target].params;
  if (specs.length === 0) return null;

  const basic = specs.filter((s) => !s.advanced);
  const advanced = specs.filter((s) => s.advanced);

  return (
    <div data-testid="param-panel" className="border-border mt-3 rounded-lg border p-2.5">
      <div className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs">
        <SlidersHorizontal className="size-3" />
        <span>编码参数</span>
      </div>

      <div className="space-y-2.5">
        {basic.map((spec) => (
          <ParamControl
            key={spec.id}
            spec={spec}
            value={values[spec.id]}
            onChange={onChange}
            disabled={disabled}
          />
        ))}
      </div>

      {advanced.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-muted-foreground hover:text-foreground mt-2.5 inline-flex items-center gap-1 text-xs"
          >
            {showAdvanced ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            高级参数（{advanced.length}）
          </button>

          {showAdvanced && (
            <div className="mt-2.5 space-y-2.5">
              {advanced.map((spec) => (
                <ParamControl
                  key={spec.id}
                  spec={spec}
                  value={values[spec.id]}
                  onChange={onChange}
                  disabled={disabled}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ParamControl({
  spec,
  value,
  onChange,
  disabled,
}: {
  spec: ParamSpec;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
}) {
  // Native controls throughout: they are keyboard- and screen-reader-correct for free,
  // and a slider that cannot be reached by keyboard is worse than a plain one.
  const id = `param-${spec.id}`;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-xs" title={spec.help}>
          {spec.label}
        </label>

        {spec.control === 'range' && (
          <span className="text-muted-foreground font-mono text-xs">
            {String(value ?? spec.default)}
          </span>
        )}
      </div>

      {spec.control === 'range' && (
        <input
          id={id}
          data-testid={id}
          type="range"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          disabled={disabled}
          value={Number(value ?? spec.default)}
          onChange={(e) => onChange(spec.id, Number(e.target.value))}
          className="accent-primary mt-1 h-1.5 w-full cursor-pointer disabled:opacity-50"
        />
      )}

      {spec.control === 'toggle' && (
        <input
          id={id}
          data-testid={id}
          type="checkbox"
          disabled={disabled}
          checked={Boolean(value ?? spec.default)}
          onChange={(e) => onChange(spec.id, e.target.checked)}
          className="mt-1 block disabled:opacity-50"
        />
      )}

      {spec.control === 'enum' && (
        <select
          id={id}
          data-testid={id}
          disabled={disabled}
          value={String(value ?? spec.default)}
          onChange={(e) => onChange(spec.id, e.target.value)}
          className={cn(
            'border-input bg-background mt-1 w-full rounded-md border px-2 py-1 text-xs',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {spec.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}

      {spec.help && <p className="text-muted-foreground mt-1 text-[11px] leading-snug">{spec.help}</p>}
    </div>
  );
}
