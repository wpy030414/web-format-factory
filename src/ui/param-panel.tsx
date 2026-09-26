import { useState } from 'react';
import { ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react';
import { FORMATS, type ParamSpec } from '@/core/registry/formats.ts';
import type { FormatId } from '@/core/types.ts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx';
import { Slider } from '@/components/ui/slider.tsx';
import { Switch } from '@/components/ui/switch.tsx';

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
  // shadcn/ui controls, which are Radix underneath. That matters because the reason these
  // used to be raw elements still holds: a slider that cannot be reached by keyboard is
  // worse than a plain one. Radix keeps the keyboard and screen-reader behaviour and adds
  // the styling, so the choice is no longer per-call-site guesswork.
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

        {spec.control === 'toggle' && (
          <Switch
            id={id}
            data-testid={id}
            disabled={disabled}
            checked={Boolean(value ?? spec.default)}
            onCheckedChange={(checked) => onChange(spec.id, checked)}
          />
        )}
      </div>

      {spec.control === 'range' && (
        <Slider
          id={id}
          data-testid={id}
          // Named here rather than by the <label> above: a label cannot be associated with
          // a span, and the element that carries role="slider" is the thumb inside. Our
          // vendored copy of the component forwards this down to it.
          aria-label={spec.label}
          className="mt-2"
          disabled={disabled}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={[Number(value ?? spec.default)]}
          onValueChange={([next]) => onChange(spec.id, next)}
        />
      )}

      {spec.control === 'enum' && (
        <Select
          disabled={disabled}
          value={String(value ?? spec.default)}
          onValueChange={(next) => onChange(spec.id, next)}
        >
          <SelectTrigger id={id} data-testid={id} size="sm" className="mt-1 w-full">
            <SelectValue />
          </SelectTrigger>
          {/* Portalled: a select's menu must escape the card's overflow, or a long option
              list is clipped by the very card that owns it. */}
          <SelectContent>
            {spec.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {spec.help && <p className="text-muted-foreground mt-1 text-[11px] leading-snug">{spec.help}</p>}
    </div>
  );
}
