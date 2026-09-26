import { useCallback, useRef, useState, type DragEvent } from 'react';
import { Upload, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils.ts';

interface DropzoneProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  compact?: boolean;
}

/**
 * Drag-and-drop target with a keyboard-reachable file picker behind it.
 *
 * A drop target alone is not accessible — the whole control is a button so it can be
 * reached and activated without a mouse.
 */
export function Dropzone({ onFiles, disabled, compact }: DropzoneProps) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      event.preventDefault();
      setOver(false);
      if (disabled) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) onFiles(files);
    },
    [disabled, onFiles],
  );

  return (
    <div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={handleDrop}
        className={cn(
          'border-border w-full rounded-xl border-2 border-dashed text-left transition-colors',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
          compact ? 'p-5' : 'p-10',
          over ? 'border-primary bg-accent' : 'hover:border-muted-foreground/40',
        )}
      >
        <div className={cn('flex items-center gap-3', compact ? '' : 'flex-col text-center')}>
          <Upload
            className={cn('text-muted-foreground shrink-0', compact ? 'size-4' : 'size-7')}
            aria-hidden
          />
          <div>
            <p className={cn('font-medium', compact ? 'text-sm' : 'text-base')}>
              {compact ? '继续拖入文件' : '把文件拖到这里，或点击选择'}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              影像与音频都可以。转换全程在这台设备上完成。
            </p>
          </div>
        </div>
      </button>

      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onFiles(files);
          // Reset so selecting the same file twice still fires a change event.
          e.target.value = '';
        }}
      />

      <p className="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
        文件不会离开你的设备——这里没有任何上传。
      </p>
    </div>
  );
}
