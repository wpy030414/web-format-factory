import { create } from 'zustand';
import { MediaEngineClient, asEngineError } from '../engines/client.ts';
import type { ConvertOutcome } from '../engines/client.ts';
import type { MediaProfile } from '../core/probe/profile.ts';
import { FORMATS } from '../core/registry/formats.ts';
import { pairLivePhotos, type PairingCandidate } from '../livephoto/detect.ts';
import { buildLivp } from '../livephoto/pack.ts';
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
  /** Encoding parameters, seeded from the target format's declared defaults. */
  params?: Record<string, unknown>;
  /**
   * Set when this entry was assembled from two dropped files.
   *
   * The pairing resolution matters to show: matching on Apple's identifier is evidence,
   * matching on the filename is a guess, and the user deserves to know which one they got.
   */
  paired?: { still: string; video: string; matchedBy: 'identifier' | 'filename' };
}

interface State {
  files: FileEntry[];
  running: number;
  engine: MediaEngineClient | null;

  addFiles: (files: File[]) => Promise<void>;
  removeFile: (id: string) => void;
  clearFinished: () => void;
  setTarget: (id: string, target: FormatId) => void;
  setParam: (id: string, key: string, value: unknown) => void;
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
        params: entry.params ?? {},
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
                      ...seedTarget(f, profile),
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

      await pairDroppedFiles(set, get);
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
      set((s) => ({
        files: s.files.map((f) => {
          // Re-picking the target that is already selected is not a change, and wiping
          // the parameters for it would throw away settings the user just made.
          if (f.id !== id || f.target === target) return f;

          // Parameters are per-target, so switching target reseeds them from that
          // format's declared defaults rather than carrying values across that may mean
          // nothing on the new one. Any acknowledgement belonged to the old target too.
          return { ...f, target, params: defaultParamsFor(target), acknowledged: false };
        }),
      }));
    },

    setParam(id, key, value) {
      set((s) => ({
        files: s.files.map((f) =>
          f.id === id ? { ...f, params: { ...f.params, [key]: value } } : f,
        ),
      }));
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
          const plan = planFor(f.profile, f.target, f.params ?? {});
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
      // Parameters change the verdict: asking for a specific codec turns a lossless
      // container change into a re-encode, and the badges have to say so.
      return planFor(entry.profile, entry.target, entry.params ?? {});
    },

    downloadAll() {
      for (const f of get().files) {
        if (f.status === 'done' && f.result) triggerDownload(f.result.blob, f.result.name);
      }
    },
  };
});

/**
 * Look for Live Photo pairs among the entries and merge each pair into one.
 *
 * A Live Photo arrives from most tools as two loose files, and showing them as two
 * unrelated entries invites the user to convert each half separately — which is exactly
 * what they did not mean.
 *
 * Rather than teach every downstream layer about pairs, a matched pair is assembled into
 * a `.livp` in memory and treated as one input. The pipeline already understands that
 * shape, so nothing below this line has to change.
 */
async function pairDroppedFiles(
  set: (fn: (s: State) => Partial<State>) => void,
  get: () => State,
): Promise<void> {
  const entries = get().files.filter((f) => f.profile && !f.paired && f.status === 'ready');

  const candidates: PairingCandidate[] = entries.map((e) => ({
    name: e.file.name,
    bytes: new Uint8Array(),
    container: e.profile!.container,
    ...(e.profile!.contentId ? { contentId: e.profile!.contentId } : {}),
  }));

  const groups = pairLivePhotos(candidates);
  if (groups.length === 0) return;

  for (const group of groups) {
    const stillEntry = entries[candidates.indexOf(group.still)];
    const videoEntry = entries[candidates.indexOf(group.video)];
    if (!stillEntry || !videoEntry) continue;

    try {
      const still = new Uint8Array(await stillEntry.file.arrayBuffer());
      const video = new Uint8Array(await videoEntry.file.arrayBuffer());
      const { bytes } = buildLivp(still, video);

      const id = stillEntry.id;
      set((s) => ({
        files: s.files
          .filter((f) => f.id !== videoEntry.id)
          .map((f) =>
            f.id === id
              ? {
                  ...f,
                  file: new File([bytes as BlobPart], `${baseNameOf(stillEntry.file.name)}.livp`),
                  profile: {
                    name: `${baseNameOf(stillEntry.file.name)}.livp`,
                    size: bytes.length,
                    container: 'zip' as const,
                    mediaClass: 'live-photo' as const,
                    livePhotoFlavor: 'apple-paired' as const,
                    videoTracks: [],
                    audioTracks: [],
                    otherTrackCount: 0,
                  },
                  target: f.target ?? 'mp4',
                  paired: {
                    still: stillEntry.file.name,
                    video: videoEntry.file.name,
                    matchedBy: group.matchedBy,
                  },
                }
              : f,
          ),
      }));
    } catch {
      // If the two will not zip together, leave them as separate entries rather than
      // dropping them — the user can still convert each half on its own.
    }
  }
}

/**
 * Give a freshly probed entry a target and the parameters that go with it.
 *
 * Both arrive together: parameters only mean anything against a specific target, so
 * seeding one without the other would leave the panel showing values the format does
 * not even accept.
 */
function seedTarget(entry: FileEntry, profile: MediaProfile): Partial<FileEntry> {
  const target = entry.target ?? pickDefaultTarget(profile);
  return {
    target,
    params: entry.params ?? (target ? defaultParamsFor(target) : {}),
  };
}

/** Seed a parameter set from a format's declared defaults. */
export function defaultParamsFor(target: FormatId): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of FORMATS[target].params) out[spec.id] = spec.default;
  return out;
}

function baseNameOf(name: string): string {
  return name.replace(/\.[^./\\]+$/, '') || 'live';
}

/**
 * A sensible default target, or `null` when nothing is feasible.
 *
 * Two rules, in order:
 *
 * 1. Never pick the format the file is already in — a default that re-encodes into the
 *    same container is a no-op the user did not ask for.
 * 2. Prefer a target that costs nothing. A container change is instant and lossless,
 *    while crossing codecs is slow and lossy, so defaulting to a transcode when a free
 *    option exists would give a poor first impression of the tool.
 *
 * Only ever picks something that actually works: defaulting to an impossible target
 * would present a Convert button that refuses to do anything.
 */
export function pickDefaultTarget(profile: MediaProfile): FormatId | null {
  const preferences: Record<string, FormatId[]> = {
    video: ['mp4', 'mkv', 'mov', 'webm'],
    audio: ['mp3', 'm4a', 'flac', 'wav'],
    'still-image': ['jpeg', 'png', 'webp'],
    'animated-image': ['gif', 'webp-anim', 'apng'],
    'live-photo': ['mp4', 'jpeg', 'gif'],
    unknown: [],
  };

  const candidates = (preferences[profile.mediaClass] ?? []).filter(
    // Compare via the format's declared containers, NOT by comparing the FormatId to the
    // ContainerId — `'mp4'` and `'isobmff-mp4'` are different vocabularies and can never
    // be equal, so that comparison silently never matched.
    (candidate) =>
      !FORMATS[candidate].containers.includes(profile.container as never) &&
      planFor(profile, candidate).feasible,
  );

  const free = candidates.find((c) => planFor(profile, c).did === 'transmux');
  return free ?? candidates[0] ?? null;
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
