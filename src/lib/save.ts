import { zipSync } from 'fflate';

import { triggerDownload } from './download.ts';

/**
 * Saving a result that is more than one file.
 *
 * Two `<a download>` clicks back to back do not work: every browser allows the first
 * download from a gesture and throttles the rest — Chrome asks, Safari drops them
 * silently. A web page cannot detect that it happened, which makes it exactly the kind of
 * quiet failure this project keeps writing down. So the pair is saved in one of two ways,
 * and never as two hopeful clicks:
 *
 *   1. straight into a folder the user picks, where supported;
 *   2. otherwise as a single `.zip`, which every OS unpacks on a double click.
 *
 * See docs/researches/live-photo-photos-import.md §7.1 for why the pair has to reach the
 * photo library as loose files at all.
 */

export interface SaveableFile {
  blob: Blob;
  name: string;
}

export type SaveOutcome = 'saved' | 'zipped' | 'cancelled' | 'failed';

interface DirectoryHandleLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{
    createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
  }>;
}

/** Whether this browser can write straight into a folder the user picks. */
export function canSaveToFolder(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** `anim.jpg` + `anim.mov` → `anim.zip`. */
export function zipNameFor(files: readonly SaveableFile[]): string {
  const first = files[0]?.name ?? 'output';
  return `${first.replace(/\.[^./\\]+$/, '') || 'output'}.zip`;
}

/**
 * Save one or more files, in a way that actually lands.
 *
 * A single file is an ordinary download — none of the above applies.
 */
export async function saveFiles(
  files: readonly SaveableFile[],
  /** `folder: false` forces the archive — for callers saving many results at once, where
   * a folder picker per result would be a stack of dialogs. */
  options: { folder?: boolean } = {},
): Promise<SaveOutcome> {
  const first = files[0];
  if (!first) return 'failed';
  if (files.length === 1) {
    triggerDownload(first.blob, first.name);
    return 'saved';
  }

  if (options.folder !== false && canSaveToFolder()) {
    try {
      const picker = (window as unknown as {
        showDirectoryPicker(options: { mode: string }): Promise<DirectoryHandleLike>;
      }).showDirectoryPicker;
      const directory = await picker.call(window, { mode: 'readwrite' });
      for (const file of files) {
        const handle = await directory.getFileHandle(file.name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(file.blob);
        await writable.close();
      }
      return 'saved';
    } catch (cause) {
      // The user closing the picker is a decision, not a failure.
      if ((cause as { name?: string })?.name === 'AbortError') return 'cancelled';
      // Anything else falls through to the archive rather than reporting a dead end.
    }
  }

  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    entries[file.name] = new Uint8Array(await file.blob.arrayBuffer());
  }
  // Level 0: both halves are already-compressed media, so deflating them buys nothing and
  // costs a pass over a file that can be 30 MB.
  const zip = zipSync(entries, { level: 0 });
  triggerDownload(new Blob([zip as BlobPart], { type: 'application/zip' }), zipNameFor(files));
  return 'zipped';
}
