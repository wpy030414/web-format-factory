/**
 * Handing a result to the system share sheet.
 *
 * This is the *only* thing a web page can do about delivery on iOS. It cannot open Photos,
 * and it cannot create a Live Photo — that takes PhotoKit's paired-video resource, which
 * no web API exposes (docs/researches/live-photo-photos-import.md §7.1). What it can do is
 * put the files in front of the user and let them pick the destination, which is enough
 * when the destination is an installed app that knows what to do with a `.livp`.
 *
 * Deliberately no UI here: what to offer when sharing is unavailable is the caller's
 * decision, and on the desktop that answer is usually "just download it".
 */

export interface ShareableFile {
  blob: Blob;
  name: string;
}

function toFile(file: ShareableFile): File {
  return new File([file.blob], file.name, { type: file.blob.type || 'application/octet-stream' });
}

/**
 * Whether this browser could share these files.
 *
 * Feature-detected rather than assumed: `navigator.share` exists on browsers that do not
 * take the `files` parameter, and calling it there throws.
 */
export function canShareFiles(files: readonly ShareableFile[]): boolean {
  if (typeof navigator === 'undefined') return false;
  const share = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (typeof share.canShare !== 'function') return false;
  try {
    return share.canShare({ files: files.map(toFile) });
  } catch {
    return false;
  }
}

export type ShareOutcome = 'shared' | 'cancelled' | 'unsupported' | 'failed';

/** Open the share sheet. A cancel is not an error and must not be reported as one. */
export async function shareFiles(files: readonly ShareableFile[]): Promise<ShareOutcome> {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
    return 'unsupported';
  }
  try {
    await navigator.share({ files: files.map(toFile) });
    return 'shared';
  } catch (cause) {
    // The user closing the sheet is an AbortError, and it is a perfectly ordinary thing to
    // do. Only a genuine failure deserves a message.
    return (cause as { name?: string })?.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}
