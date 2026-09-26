import { create } from 'zustand';
import { MediaEngineClient, asEngineError } from '../engines/client.ts';
import type { ConvertOutcome } from '../engines/client.ts';
import type { MediaProfile } from '../core/probe/profile.ts';
import { FORMATS } from '../core/registry/formats.ts';
import { planFor, type ResolvedPlan } from '../core/routing/resolve.ts';
import type { FormatId } from '../core/types.ts';

export type FileStatus = 'probing' | 'ready' | 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface FileEntry {
  id: string;
  file: File;
  profile: MediaProfile | null;
  status: FileStatus;
  target: FormatId | null;
  progress?: number;
  did?: 'transmux' | 'transcode';
  result?: { blob: Blob; name: string; size: number };
  error?: string;
  /** Set once the user has acknowledged a critical loss for this file. */
  acknowledged?: boolean;
}

interface State {
  files: FileEntry[];
  running: number;
  engine: MediaEngineClient | null;

  addFiles: (files: File[]) => Promise<void>;
  removeFile: (id: string) => void;
  clearFinished: () => void;
  setTarget: (id: string, target: FormatId) => void;
  acknowledge: (id: string, value: boolean) => void;
  startAll: () => void;
  cancelAll: () => void;
  planForFile: (id: string) => ResolvedPlan | null;
  downloadAll: () => void;
}

/** Keeps the UI responsive without starting a fight over memory or the GPU encoder. */
const MAX_CONCURRENT = 2;

let counter = 0;
const nextId = () => `f${++counter}`;

/**
 * The conversion store.
 *
 * Job state lives here rather than in React state on purpose: jobs outlive the
 * components that started them, and progress updates arrive fast enough that routing
 * them through the reconciler would be wasteful.
 */
export const useStore = create<State>((set, get) => {
  /** Lazily created so simply loading the page does not spin up a worker. */
  const engine = () => {
    const existing = get().engine;
    if (existing) return existing;
    const created = new MediaEngineClient();
    set({ engine: created });
    return created;
  };

  /** Run one file's conversion to completion, updating state as it goes. */
  const runOne = async (entry: FileEntry): Promise<void> => {
    const state = get();
    const plan = state.planForFile(entry.id);
    if (!plan?.feasible || !entry.target) {
      set((s) => ({
        files: s.files.map((f) =>
          f.id === entry.id ? { ...f, status: 'error', error: '该转换不可行' } : f,
        ),
      }));
      return;
    }

    set((s) => ({
      files: s.files.map((f) => (f.id === entry.id ? { ...f, status: 'running' } : f)),
    }));

    try {
      const outcome: ConvertOutcome = await engine().convert({
        jobId: entry.id,
        file: entry.file,
        fileName: entry.file.name,
        target: entry.target,
        params: {},
        onProgress: (ratio) =>
          set((s) => ({
            files: s.files.map((f) => (f.id === entry.id ? { ...f, progress: ratio } : f)),
          })),
      });

      set((s) => ({
        files: s.files.map((f) =>
          f.id === entry.id
            ? {
                ...f,
                status: 'done',
                did: outcome.did,
                result: {
                  blob: outcome.output,
                  name: outcome.outputName,
                  size: outcome.output.size,
                },
              }
            : f,
        ),
      }));
    } catch (cause) {
      const { message } = asEngineError(cause);
      set((s) => ({
        files: s.files.map((f) =>
          f.id === entry.id
            ? { ...f, status: message.includes('取消') ? 'cancelled' : 'error', error: message }
            : f,
        ),
      }));
    }
  };

  /** Pull work from the queue while there is capacity. */
  const pump = () => {
    const state = get();
    if (state.running >= MAX_CONCURRENT) return;

    const next = state.files.find((f) => f.status === 'queued');
    if (!next) return;

    set((s) => ({
      running: s.running + 1,
      files: s.files.map((f) => (f.id === next.id ? { ...f, status: 'running' } : f)),
    }));

    void runOne(next).finally(() => {
      set((s) => ({ running: Math.max(0, s.running - 1) }));
      pump();
    });
  };

  return {
    files: [],
    running: 0,
    engine: null,

    async addFiles(incoming) {
      const entries: FileEntry[] = incoming.map((file) => ({
        id: nextId(),
        file,
        profile: null,
        status: 'probing',
        target: null,
      }));
      set((s) => ({ files: [...s.files, ...entries] }));

      // Probing runs in the worker — it needs the media library, which must not be
      // pulled into the entry chunk. Each card updates as its own result lands.
      const client = engine();
      await Promise.all(
        entries.map(async (entry) => {
          try {
            const profile = await client.probe(entry.file, entry.file.name);
            set((s) => ({
              files: s.files.map((f) =>
                f.id === entry.id
                  ? {
                      ...f,
                      profile,
                      status: 'ready',
                      // Preselect a sensible target, or leave it null when nothing is
                      // feasible so the user sees the refusals rather than a guess.
                      target: f.target ?? pickDefaultTarget(profile),
                    }
                  : f,
              ),
            }));
          } catch (cause) {
            const { message } = asEngineError(cause);
            set((s) => ({
              files: s.files.map((f) =>
                f.id === entry.id ? { ...f, status: 'error', error: message } : f,
              ),
            }));
          }
        }),
      );
    },

    removeFile(id) {
      set((s) => ({ files: s.files.filter((f) => f.id !== id) }));
    },

    clearFinished() {
      set((s) => ({
        files: s.files.filter((f) => f.status !== 'done' && f.status !== 'cancelled'),
      }));
    },

    setTarget(id, target) {
      set((s) => ({ files: s.files.map((f) => (f.id === id ? { ...f, target } : f)) }));
    },

    acknowledge(id, value) {
      set((s) => ({
        files: s.files.map((f) => (f.id === id ? { ...f, acknowledged: value } : f)),
      }));
    },

    startAll() {
      set((s) => ({
        files: s.files.map((f) => {
          if (!f.profile || !f.target) return f;
          const plan = planFor(f.profile, f.target);
          if (!plan.feasible) return f;
          // A critical loss must be acknowledged before we will start.
          if (plan.needsAcknowledgement && !f.acknowledged) return f;
          return { ...f, status: 'queued' as FileStatus, progress: undefined, error: undefined };
        }),
      }));
      pump();
    },

    cancelAll() {
      const state = get();
      state.engine?.dispose();
      set((s) => ({
        engine: null,
        running: 0,
        files: s.files.map((f) =>
          f.status === 'running' || f.status === 'queued' ? { ...f, status: 'cancelled' } : f,
        ),
      }));
    },

    planForFile(id) {
      const entry = get().files.find((f) => f.id === id);
      if (!entry?.profile || !entry.target) return null;
      return planFor(entry.profile, entry.target);
    },

    downloadAll() {
      for (const f of get().files) {
        if (f.status === 'done' && f.result) triggerDownload(f.result.blob, f.result.name);
      }
    },
  };
});

/**
 * A sensible default target, or `null` when nothing is feasible.
 *
 * Only ever picks something that actually works — defaulting to an impossible target
 * would present the user with a Convert button that refuses to do anything.
 */
function pickDefaultTarget(profile: MediaProfile): FormatId | null {
  const preferences: Record<string, FormatId[]> = {
    video: ['mp4', 'webm', 'mkv'],
    audio: ['mp3', 'm4a', 'flac', 'wav'],
    'still-image': ['jpeg', 'png', 'webp'],
    'animated-image': ['gif', 'webp-anim', 'apng'],
    'live-photo': ['mp4', 'jpeg', 'gif'],
    unknown: [],
  };

  for (const candidate of preferences[profile.mediaClass] ?? []) {
    // Skip the format the file is already in: a default that re-encodes into the same
    // container is a no-op the user did not ask for.
    //
    // Compare via the format's declared containers, NOT by comparing the FormatId to the
    // ContainerId — `'mp4'` and `'isobmff-mp4'` are different vocabularies and can never
    // be equal, so that comparison silently never matched.
    if (FORMATS[candidate].containers.includes(profile.container as never)) continue;
    if (planFor(profile, candidate).feasible) return candidate;
  }
  return null;
}

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
