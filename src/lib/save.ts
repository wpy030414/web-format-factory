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
 * Give every file a name no other file in the same container already has.
 *
 * Only matters when results from different jobs are merged into one archive or one folder,
 * which is the whole point of a batch save: two sources can easily produce the same output
 * name, and a container keyed by name would keep one of them and drop the other without a
 * word. Saving them one at a time never had this problem — the browser de-duplicated — so
 * merging has to take the job over.
 */
export function disambiguate(files: readonly SaveableFile[]): SaveableFile[] {
  const used = new Set<string>();

  return files.map((file) => {
    if (!used.has(file.name)) {
      used.add(file.name);
      return file;
    }

    const dot = file.name.lastIndexOf('.');
    const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
    const extension = dot > 0 ? file.name.slice(dot) : '';
    let n = 2;
    let candidate = `${stem} (${n})${extension}`;
    while (used.has(candidate)) candidate = `${stem} (${++n})${extension}`;
    used.add(candidate);
    return { ...file, name: candidate };
  });
}

/**
 * Save one or more files, in a way that actually lands.
 *
 * A single file is an ordinary download — none of the above applies.
 *
 * Many files at once must be ONE call. Saving them in a loop is indistinguishable from
 * saving only the first: every browser allows the first `<a download>` from a gesture and
 * throttles the rest, and the page cannot detect that it happened.
 */
export async function saveFiles(
  files: readonly SaveableFile[],
  options: {
    /** `folder: false` forces the archive, for callers that must not show a picker. */
    folder?: boolean;
    /** Name for the archive, when one is produced. Defaults to the first file's stem. */
    archiveName?: string;
  } = {},
): Promise<SaveOutcome> {
  const first = files[0];
  if (!first) return 'failed';
  if (files.length === 1) {
    triggerDownload(first.blob, first.name);
    return 'saved';
  }

  const unique = disambiguate(files);

  if (options.folder !== false && canSaveToFolder()) {
    try {
      const picker = (window as unknown as {
        showDirectoryPicker(options: { mode: string }): Promise<DirectoryHandleLike>;
      }).showDirectoryPicker;
      const directory = await picker.call(window, { mode: 'readwrite' });
      for (const file of unique) {
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
  for (const file of unique) {
    entries[file.name] = new Uint8Array(await file.blob.arrayBuffer());
  }
  // Level 0: both halves are already-compressed media, so deflating them buys nothing and
  // costs a pass over a file that can be 30 MB.
  const zip = zipSync(entries, { level: 0 });
  triggerDownload(
    new Blob([zip as BlobPart], { type: 'application/zip' }),
    options.archiveName ?? zipNameFor(unique),
  );
  return 'zipped';
}
