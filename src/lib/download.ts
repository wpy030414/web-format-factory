/**
 * Save a blob to disk under a given name.
 *
 * Lives here rather than in the store so the two things that need it — the store and the
 * multi-file saver — do not have to import each other.
 */
export function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
