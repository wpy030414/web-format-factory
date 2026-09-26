import { create } from 'zustand';
import { MediaEngineClient, asEngineError } from '../engines/client.ts';
import { saveFiles, canSaveToFolder, writeOneToFolder } from '../lib/save.ts';
import { triggerDownload } from '../lib/download.ts';
import {
  openStore as openIdbStore,
  putResult as putIdbResult,
  putCompanion as putIdbCompanion,
  getResult as getIdbResult,
} from '../lib/idb-store.ts';
import type { DirectoryHandleLike } from '../lib/save.ts';
import type { ConvertOutcome } from '../engines/client.ts';
import type { JobProgress } from '../engines/types.ts';
import type { MediaProfile } from '../core/probe/profile.ts';
import { FORMATS, ALL_FORMAT_IDS } from '../core/registry/formats.ts';
import { pairLivePhotos, type PairingCandidate } from '../livephoto/detect.ts';
import { buildLivp } from '../livephoto/pack.ts';
import { planFor, type ResolvedPlan } from '../core/routing/resolve.ts';
import { readRouteCapabilities, type RouteCapabilities } from '../core/routing/gates.ts';
import { probeEncoders } from '../core/caps.ts';
import { WASM_ENCODED_CODECS } from '../core/codecs.ts';
import type { CodecId, FormatId } from '../core/types.ts';

export type FileStatus = 'probing' | 'ready' | 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/** How the app lands finished results to free memory. */
export type DrainMode = 'none' | 'folder' | 'idb';

export interface FileEntry {
  id: string;
  file: File;
  profile: MediaProfile | null;
  status: FileStatus;
  target: FormatId | null;
  /**
   * The latest word from the engine, kept whole.
   *
   * Not a bare ratio: the phase, the label and the frame count are what let the card say
   * what is happening while there is no percentage to show.
   */
  progress?: JobProgress;
  did?: 'transmux' | 'transcode';
  result?: {
    blob: Blob;
    name: string;
    size: number;
    /** A second file that belongs with the first: Apple's Live Photo is a pair. */
    companion?: { blob: Blob; name: string; size: number };
  };
  /** Set once the result blob has been released — written to disk or IDB — and is no
   *  longer held in memory.  The name and size stay so the card can still show what
   *  was produced. */
  drained?: boolean;
  error?: string;
  /** Set once the user has acknowledged a critical loss for this file. */
  acknowledged?: boolean;
  /** Encoding parameters, seeded from the target format's declared defaults. */
  params?: Record<string, unknown>;
  /**
   * Set when this entry was assembled from two dropped files.
   *
   * The pairing resolution matters to show: matching on Apple's identifier is evidence,
   * matching on the filename is a guess, and a user deciding whether to trust the pairing
   * deserves to know which one they got.
   *
   * The two originals are kept rather than only their names, so that unpairing restores
   * exactly what was dropped instead of a re-derivation of it. The cost is holding a Live
   * Photo's bytes twice, which for a format measured in megabytes is worth paying for a
   * reversible action.
   */
  paired?: {
    still: File;
    video: File;
    matchedBy: 'identifier' | 'filename' | 'manual';
  };
}

/**
 * The batch's shared conversion configuration.
 *
 * Batch mode exists because batch use is the normal use — dropping ten files and picking a
 * target ten times is the thing worth removing, not the single-file case. It is off by
 * default, and off means the per-file fields govern exactly as they always have.
 */
export interface BatchChoice {
  enabled: boolean;
  target: FormatId | null;
  params: Record<string, unknown>;
}

export const NO_BATCH: BatchChoice = { enabled: false, target: null, params: {} };

/**
 * Drop the shared target while keeping the mode.
 *
 * Used when the last file leaves: a batch with nothing in it has nothing to convert to, and
 * keeping the departed file's target would make the next drop inherit a choice made about
 * something else.
 */
const clearBatchTarget = (batch: BatchChoice): BatchChoice =>
  batch.target === null ? batch : { ...batch, target: null, params: {} };

/**
 * What a file will actually be converted to.
 *
 * The one place the mode is consulted. The planner, the toolbar's counts and the job
 * itself all ask this rather than reading `entry.target`, so "what happens if I press
 * Convert" has a single answer instead of several that can quietly disagree.
 */
export function resolveChoice(
  entry: Pick<FileEntry, 'target' | 'params'>,
  batch: BatchChoice,
): { target: FormatId | null; params: Record<string, unknown> } {
  return batch.enabled
    ? { target: batch.target, params: batch.params }
    : { target: entry.target, params: entry.params ?? {} };
}

/**
 * A shared target for a batch that does not have one yet.
 *
 * Whatever the first identifiable file in the batch would have been offered on its own. For
 * a batch of one kind — the ordinary case — that is the very target the single card would
 * have preselected, so switching batch mode on changes nothing the user can see. For a
 * mixed batch it is the first file's answer, which a later file may not be able to reach:
 * the batch runs anyway and says so per file, rather than inventing a fallback.
 */
export function seedBatchChoice(
  files: readonly FileEntry[],
  caps: RouteCapabilities,
): { target: FormatId | null; params: Record<string, unknown> } {
  const first = files.find((f) => f.profile && f.profile.mediaClass !== 'unknown');
  if (!first?.profile) return { target: null, params: {} };
  const target = pickDefaultTarget(first.profile, caps);
  return { target, params: target ? defaultParamsFor(target) : {} };
}

/**
 * Every target at least one file in the batch can reach.
 *
 * A union, deliberately, and not an intersection: a batch holding an image and a video has
 * no target in common at all, so an intersection would offer nothing and the honest-looking
 * choice would be the useless one. Grouping is by format family, so the rows read the same
 * as a single card's.
 */
export function offeredTargets(files: readonly FileEntry[], caps: RouteCapabilities): FormatId[] {
  const profiled = files.filter((f) => f.profile && f.profile.mediaClass !== 'unknown');
  return ALL_FORMAT_IDS.filter((t) => profiled.some((f) => planFor(f.profile!, t, caps).feasible));
}

/**
 * Whether Convert would act on this file right now.
 *
 * Shared with the toolbar so the count on the button is the count `startAll` will queue. A
 * count that promises more than the button delivers is a silent no-op, which is worse than
 * a disabled button: nothing happens and nothing says why.
 */
export function isActionable(f: FileEntry, caps: RouteCapabilities, batch: BatchChoice): boolean {
  if (!f.profile) return false;
  if (f.status === 'done' || f.status === 'running' || f.status === 'queued') return false;
  const { target, params } = resolveChoice(f, batch);
  if (!target) return false;
  const plan = planFor(f.profile, target, caps, params);
  if (!plan.feasible) return false;
  if (plan.needsAcknowledgement && !f.acknowledged) return false;
  return true;
}

/** Feasible, but waiting on the user to accept a loss. Counted separately so the UI can explain. */
export function isAwaitingAck(f: FileEntry, caps: RouteCapabilities, batch: BatchChoice): boolean {
  if (!f.profile) return false;
  if (f.status === 'done' || f.status === 'running' || f.status === 'queued') return false;
  const { target, params } = resolveChoice(f, batch);
  if (!target) return false;
  const plan = planFor(f.profile, target, caps, params);
  return plan.feasible && plan.needsAcknowledgement && !f.acknowledged;
}

/** Ready, but with nothing it could be converted to — a file that would strand without a word. */
export function isBlocked(f: FileEntry, batch: BatchChoice): boolean {
  if (f.status !== 'ready' || !f.profile) return false;
  return !resolveChoice(f, batch).target || f.profile.mediaClass === 'unknown';
}

interface State {
  files: FileEntry[];
  running: number;
  engine: MediaEngineClient | null;
  caps: RouteCapabilities;
  batch: BatchChoice;

  /**
   * How finished results leave memory.
   *
   * `'none'` — blobs stay in the store (traditional behaviour).
   * `'folder'` — each result is written straight into a directory the user picked
   *   and its blob is released immediately afterwards.
   * `'idb'` — each result is stored in a per-session IndexedDB database, whose blob
   *   is released from memory; the result can be retrieved for download later in
   *   the same page load (the DB is nuked on refresh).
   */
  drainMode: DrainMode;
  /** Folder handle, set when the user picks a save directory via FSAA. */
  drainHandle: DirectoryHandleLike | null;
  /** IndexedDB connection, lazily opened when drainMode switches to 'idb'. */
  idbDb: IDBDatabase | null;

  measureCapabilities: () => void;
  addFiles: (files: File[]) => Promise<void>;
  removeFile: (id: string) => void;
  clearFinished: () => void;
  setTarget: (id: string, target: FormatId) => void;
  setParam: (id: string, key: string, value: unknown) => void;
  setBatch: (enabled: boolean) => void;
  setBatchTarget: (target: FormatId) => void;
  setBatchParam: (key: string, value: unknown) => void;
  acknowledge: (id: string, value: boolean) => void;
  startAll: () => void;
  cancelAll: () => void;
  planForFile: (id: string) => ResolvedPlan | null;
  downloadAll: () => void;
  pairManually: (stillId: string, videoId: string) => Promise<void>;
  unpair: (id: string) => Promise<void>;
  /** Let the user pick a folder to receive results as they finish. */
  pickDrainFolder: () => Promise<void>;
  /** Stop writing to the folder and leave future results in memory. */
  clearDrainFolder: () => void;
  /** Switch to IndexedDB drain mode. Async: it opens the per-session database first. */
  enableIdbDrain: () => Promise<void>;
  /** Download a single drained (FSAA or IDB) result. */
  downloadDrained: (id: string) => Promise<void>;
}

/**
 * How many conversions may run at once.
 *
 * Two, and now actually two: the scheduler used to start one job per `pump()` and only
 * re-enter on completion, so the second slot was never filled and a batch ran strictly one
 * file at a time. Measured on four 20s 720p re-encodes: 8.9s serial, 4.8s at two, 4.3s at
 * four. Nearly all of the available speedup is in the first step, and the last one buys
 * 10% for double the peak memory — each job holds its input and output whole, so four
 * 500 MB sources is several gigabytes. Two is where the curve bends.
 */
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

  /**
   * Coalesce progress reports to one update per animation frame.
   *
   * Reports arrive once per packet, and each one would otherwise map the entire file list
   * and re-render every card. Dropping the values in between costs nothing — only the
   * latest is ever drawn — but the volume is real: a container copy has no decode step to
   * slow it down, which is precisely the case whose progress is most worth watching.
   */
  const pendingProgress = new Map<string, JobProgress>();
  let progressFrame: number | null = null;

  const flushProgress = (): void => {
    progressFrame = null;
    if (pendingProgress.size === 0) return;
    const batch = new Map(pendingProgress);
    pendingProgress.clear();
    set((s) => ({
      files: s.files.map((f) => {
        const progress = batch.get(f.id);
        return progress ? { ...f, progress } : f;
      }),
    }));
  };

  const reportProgress = (id: string, progress: JobProgress): void => {
    pendingProgress.set(id, progress);
    if (progressFrame !== null) return;
    // No frame clock means no renderer to spare — land it immediately rather than lose it.
    if (typeof requestAnimationFrame !== 'function') {
      flushProgress();
      return;
    }
    progressFrame = requestAnimationFrame(flushProgress);
  };

  /** Run one file's conversion to completion, updating state as it goes. */
  const runOne = async (entry: FileEntry): Promise<void> => {
    const state = get();
    // Captured once, at the start: flipping the switch mid-job must not change what a job
    // already in flight is doing.
    const { target, params } = resolveChoice(entry, state.batch);
    const plan = state.planForFile(entry.id);
    if (!plan?.feasible || !target) {
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
        target,
        params,
        onProgress: (progress) => reportProgress(entry.id, progress),
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
                  ...(outcome.companion
                    ? {
                        companion: {
                          blob: outcome.companion.blob,
                          name: outcome.companion.name,
                          size: outcome.companion.blob.size,
                        },
                      }
                    : {}),
                },
              }
            : f,
        ),
      }));

      // Land the result to free memory if a drain mode is active.  This runs after
      // the store update so the card renders "done" first — landing is invisible
      // and the user sees the finished state before the blob is released.
      void landResult(entry.id, {
        blob: outcome.output,
        name: outcome.outputName,
        size: outcome.output.size,
        ...(outcome.companion
          ? { companion: outcome.companion }
          : {}),
      });
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
    // Fill every free slot, not just one. A `pump()` that starts a job and returns does not
    // come back until that job finishes, so with a single call site the second slot sat
    // empty for the whole batch: the limit said 2 and the batch ran strictly one file at a
    // time. Measured, not assumed — see MAX_CONCURRENT below for the numbers.
    for (;;) {
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
    }
  };

  /** Put a fresh entry into the list and fill in its profile as the worker answers. */
  const probeEntries = async (entries: FileEntry[]): Promise<void> => {
    set((s) => ({ files: [...s.files, ...entries] }));

    // Probing runs in the worker — it needs the media library, which must not be pulled
    // into the entry chunk. Each card updates as its own result lands.
    const client = engine();
    await Promise.all(
      entries.map(async (entry) => {
        try {
          const profile = await client.probe(entry.file, entry.file.name);
          set((s) => {
            const files = s.files.map((f) =>
              f.id === entry.id
                ? {
                    ...f,
                    profile,
                    status: 'ready' as FileStatus,
                    // Preselect a sensible target, or leave it null when nothing is
                    // feasible so the user sees the refusals rather than a guess.
                    ...seedTarget(f, profile, s.caps),
                  }
                : f,
            );
            // Batch mode can be switched on before anything is ready to give it a target.
            // The first file to arrive supplies one — and only the first, so a choice the
            // user has since made is never overwritten by a straggler finishing later.
            const batch =
              s.batch.enabled && !s.batch.target
                ? { enabled: true, ...seedBatchChoice(files, s.caps) }
                : s.batch;
            return { files, batch };
          });
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
  };

  /**
   * Release the result blob for one entry, keeping the name and size so the card can
   * still show what was produced. Callers have already landed the blob elsewhere.
   */
  const evictResult = (id: string): void => {
    set((s) => ({
      files: s.files.map((f) =>
        f.id === id && f.result
          ? {
              ...f,
              drained: true,
              result: {
                name: f.result.name,
                size: f.result.size,
                blob: undefined as unknown as Blob,
                // Keep the companion's name and size so the card can still show "两个文件"
                // rather than pretending the second half never existed.
                ...(f.result.companion
                  ? {
                      companion: {
                        blob: undefined as unknown as Blob,
                        name: f.result.companion.name,
                        size: f.result.companion.size,
                      },
                    }
                  : {}),
              },
            }
          : f,
      ),
    }));
  };

  /** Make sure the IDB connection is open (lazy). */
  const ensureIdb = async (): Promise<IDBDatabase> => {
    const existing = get().idbDb;
    if (existing) return existing;
    const db = await openIdbStore();
    set({ idbDb: db });
    return db;
  };

  /**
   * Write a finished result out of memory.
   *
   * In folder mode the blob goes to the user's chosen directory. In IDB mode it goes to
   * the per-session IndexedDB. On failure the blob stays in the entry — it is the only
   * copy and dropping it would be data loss.
   */
  const landResult = async (id: string, outcome: {
    blob: Blob;
    name: string;
    size: number;
    companion?: { blob: Blob; name: string };
  }): Promise<void> => {
    const mode = get().drainMode;
    if (mode === 'none') return;

    if (mode === 'folder') {
      const handle = get().drainHandle;
      if (!handle) return;
      try {
        await writeOneToFolder(handle, outcome.blob, outcome.name);
        if (outcome.companion) {
          await writeOneToFolder(handle, outcome.companion.blob, outcome.companion.name);
        }
      } catch {
        // Write failed — keep the blob in memory rather than losing it.
        return;
      }
      evictResult(id);
      return;
    }

    if (mode === 'idb') {
      try {
        const db = await ensureIdb();
        await putIdbResult(db, id, outcome.blob, outcome.name, outcome.size);
        if (outcome.companion) {
          await putIdbCompanion(db, id, outcome.companion.blob, outcome.companion.name);
        }
      } catch {
        return;
      }
      evictResult(id);
    }
  };

  return {
    files: [],
    running: 0,
    engine: null,
    caps: readRouteCapabilities(),
    batch: NO_BATCH,
    drainMode: 'none',
    drainHandle: null,
    idbDb: null,

    measureCapabilities() {
      void probeEncoders().then(({ video, audio }) => {
        const encodable = new Set<CodecId>();

        for (const table of [video, audio]) {
          for (const [id, ok] of Object.entries(table)) {
            if (ok === true) encodable.add(id as CodecId);
          }
        }

        // Three codecs no browser can encode are still producible *here*, because the app
        // carries its own encoders for them. Asking only the browser would report a
        // capability this build has.
        for (const id of WASM_ENCODED_CODECS) encodable.add(id);

        set((s) => ({ caps: { ...s.caps, encodable } }));
      });
    },

    async addFiles(incoming) {
      await probeEntries(incoming.map(newEntry));
      await pairDroppedFiles(set, get);
    },

    async pairManually(stillId, videoId) {
      const state = get();
      const still = state.files.find((f) => f.id === stillId);
      const video = state.files.find((f) => f.id === videoId);
      // Only two loose, unpaired, ready files can be joined; anything else means the card
      // moved under the click and the right answer is to do nothing rather than guess.
      if (!still || !video || still.paired || video.paired) return;
      if (still.status !== 'ready' || video.status !== 'ready') return;

      await mergePair(set, still, video, 'manual');
    },

    async unpair(id) {
      const entry = get().files.find((f) => f.id === id);
      const halves = entry?.paired;
      if (!entry || !halves) return;

      // Put the two originals back and probe them again from scratch. Carrying anything
      // over from the merged card would be wrong: a Live Photo entry has one target and
      // one set of parameters, and neither means anything for a loose JPEG and a loose
      // MOV — that is precisely why they were merged into one in the first place.
      set((s) => ({ files: s.files.filter((f) => f.id !== id) }));
      await probeEntries([newEntry(halves.still), newEntry(halves.video)]);
    },

    removeFile(id) {
      set((s) => {
        const files = s.files.filter((f) => f.id !== id);
        return { files, batch: files.length === 0 ? clearBatchTarget(s.batch) : s.batch };
      });
    },

    clearFinished() {
      set((s) => {
        const files = s.files.filter((f) => f.status !== 'done' && f.status !== 'cancelled');
        return { files, batch: files.length === 0 ? clearBatchTarget(s.batch) : s.batch };
      });
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

    setBatch(enabled) {
      set((s) => {
        // Turning it on with nothing chosen yet inherits the first file's own default, so
        // the batch starts from something the user would have picked anyway.
        const batch =
          enabled && !s.batch.target
            ? { enabled: true, ...seedBatchChoice(s.files, s.caps) }
            : { ...s.batch, enabled };

        return {
          batch,
          // Every acknowledgement was given against a particular target. Changing which
          // target governs a file — which is what flipping the mode does — invalidates all
          // of them, in both directions. Re-asking costs a click; a stale tick silently
          // releasing a destructive conversion is the kind of lie this app exists to avoid.
          files: s.files.map((f) => (f.acknowledged ? { ...f, acknowledged: false } : f)),
        };
      });
    },

    setBatchTarget(target) {
      // Re-picking the target that is already chosen is not a change, and wiping the
      // parameters for it would throw away settings the user just made. Same rule as the
      // per-file picker, and it matters more here: one click now affects every file.
      if (get().batch.target === target) return;

      set((s) => ({
        batch: { ...s.batch, target, params: defaultParamsFor(target) },
        files: s.files.map((f) => (f.acknowledged ? { ...f, acknowledged: false } : f)),
      }));
    },

    setBatchParam(key, value) {
      set((s) => ({ batch: { ...s.batch, params: { ...s.batch.params, [key]: value } } }));
    },

    acknowledge(id, value) {
      set((s) => ({
        files: s.files.map((f) => (f.id === id ? { ...f, acknowledged: value } : f)),
      }));
    },

    startAll() {
      set((s) => ({
        files: s.files.map((f) => {
          // Deliberately the same predicate the toolbar counts with. The button must not
          // promise work this loop will then skip — that is a silent no-op, and a silent
          // no-op is worse than a disabled button.
          if (!isActionable(f, s.caps, s.batch)) return f;
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
      if (!entry?.profile) return null;
      const { target, params } = resolveChoice(entry, get().batch);
      if (!target) return null;
      // Parameters change the verdict: asking for a specific codec turns a lossless
      // container change into a re-encode, and the badges have to say so.
      return planFor(entry.profile, target, get().caps, params);
    },

    downloadAll() {
      // In folder mode the files are already on disk — nothing to download.
      const state = get();
      if (state.drainMode === 'folder') return;

      // Collect whatever blobs are still in memory, plus those in IDB.
      const memFiles = state.files
        .filter((f) => f.status === 'done' && f.result?.blob)
        .flatMap((f) => resultFiles({ blob: f.result!.blob!, name: f.result!.name, companion: f.result!.companion ? { blob: f.result!.companion.blob!, name: f.result!.companion.name } : undefined }));

      // For IDB mode, also collect drained entries — we read them back on demand.
      if (state.drainMode === 'idb' && state.idbDb) {
        const drainedIds = state.files
          .filter((f) => f.status === 'done' && f.drained && !f.result?.blob)
          .map((f) => f.id);
        if (drainedIds.length > 0) {
          void (async () => {
            const db = state.idbDb!;
            const allFiles: { blob: Blob; name: string }[] = [];
            for (const id of drainedIds) {
              const record = await getIdbResult(db, id);
              if (record) allFiles.push(record);
            }
            // Merge with in-memory files, deduplicate by name
            const combined = [...memFiles, ...allFiles];
            if (combined.length === 0) return;
            void saveFiles(combined, { archiveName: 'Web Format Factory.zip' });
          })();
          return;
        }
      }

      if (memFiles.length === 0) return;
      void saveFiles(memFiles, { archiveName: 'Web Format Factory.zip' });
    },

    async pickDrainFolder() {
      if (!canSaveToFolder()) return;
      try {
        const picker = (window as unknown as {
          showDirectoryPicker(options: { mode: string }): Promise<DirectoryHandleLike>;
        }).showDirectoryPicker;
        const handle = await picker.call(window, { mode: 'readwrite' });
        set({ drainHandle: handle, drainMode: 'folder' });
      } catch (cause) {
        // User cancelled — leave drainMode as 'none'.
        if ((cause as { name?: string })?.name === 'AbortError') return;
      }
    },

    clearDrainFolder() {
      set({ drainHandle: null, drainMode: 'none' });
    },

    async enableIdbDrain() {
      const db = await ensureIdb();
      set({ drainMode: 'idb', idbDb: db });
    },

    async downloadDrained(id) {
      const entry = get().files.find((f) => f.id === id);
      if (!entry?.drained || !entry.result) return;

      const mode = get().drainMode;
      if (mode === 'folder') {
        // Already on disk — nothing to do.
        return;
      }

      if (mode === 'idb') {
        const db = get().idbDb;
        if (!db) return;
        const record = await getIdbResult(db, id);
        if (!record) return;
        // Also fetch companion if present
        const companion = await getIdbResult(db, `${id}/companion`);
        const files = [{ blob: record.blob, name: record.name }];
        if (companion) files.push({ blob: companion.blob, name: companion.name });
        void saveFiles(files);
      }
    },
  };
});

function newEntry(file: File): FileEntry {
  return { id: nextId(), file, profile: null, status: 'probing', target: null };
}

/**
 * Look for Live Photo pairs among the entries and merge each pair into one.
 *
 * A Live Photo arrives from most tools as two loose files, and showing them as two
 * unrelated entries invites the user to convert each half separately — which is exactly
 * what they did not mean. What this cannot do is pair two files whose identifiers disagree
 * and whose names differ; that is what the manual pairing on the card is for.
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
    await mergePair(set, stillEntry, videoEntry, group.matchedBy);
  }
}

/**
 * Assemble two halves into one Live Photo.
 *
 * Rather than teach every downstream layer about pairs, the two files are zipped into a
 * `.livp` in memory and treated as a single input. The pipeline already understands that
 * shape, so nothing below this line has to change.
 *
 * @returns whether the two were successfully joined.
 */
async function mergePair(
  set: (fn: (s: State) => Partial<State>) => void,
  stillEntry: FileEntry,
  videoEntry: FileEntry,
  matchedBy: 'identifier' | 'filename' | 'manual',
): Promise<boolean> {
  try {
    const still = new Uint8Array(await stillEntry.file.arrayBuffer());
    const video = new Uint8Array(await videoEntry.file.arrayBuffer());
    const { bytes } = buildLivp(still, video);

    const id = stillEntry.id;
    const name = `${baseNameOf(stillEntry.file.name)}.livp`;

    set((s) => ({
      files: s.files
        .filter((f) => f.id !== videoEntry.id)
        .map((f) =>
          f.id === id
            ? {
                ...f,
                file: new File([bytes as BlobPart], name),
                profile: {
                  name,
                  size: bytes.length,
                  container: 'zip' as const,
                  mediaClass: 'live-photo' as const,
                  livePhotoFlavor: 'apple-paired' as const,
                  videoTracks: [],
                  audioTracks: [],
                  otherTrackCount: 0,
                },
                target: f.target ?? 'mp4',
                paired: { still: stillEntry.file, video: videoEntry.file, matchedBy },
              }
            : f,
        ),
    }));
    return true;
  } catch {
    // If the two will not zip together, leave them as separate entries rather than
    // dropping them — the user can still convert each half on its own.
    return false;
  }
}

/**
 * Give a freshly probed entry a target and the parameters that go with it.
 *
 * Both arrive together: parameters only mean anything against a specific target, so
 * seeding one without the other would leave the panel showing values the format does
 * not even accept.
 */
function seedTarget(
  entry: FileEntry,
  profile: MediaProfile,
  caps: RouteCapabilities,
): Partial<FileEntry> {
  const target = entry.target ?? pickDefaultTarget(profile, caps);
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
export function pickDefaultTarget(
  profile: MediaProfile,
  caps: RouteCapabilities,
): FormatId | null {
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
      planFor(profile, candidate, caps).feasible,
  );

  const free = candidates.find((c) => planFor(profile, c, caps).did === 'transmux');
  return free ?? candidates[0] ?? null;
}

/**
 * Every file a finished result consists of, primary first.
 *
 * Almost every result is one file. Apple's Live Photo is the exception: asked for as two
 * files it comes back as a still plus a video, and both are useless without the other.
 */
export function resultFiles(result: {
  blob: Blob;
  name: string;
  companion?: { blob: Blob; name: string };
}): { blob: Blob; name: string }[] {
  const files = [{ blob: result.blob, name: result.name }];
  if (result.companion) files.push({ blob: result.companion.blob, name: result.companion.name });
  return files;
}

/** Save every file a result consists of. */
export function downloadResult(result: {
  blob: Blob;
  name: string;
  companion?: { blob: Blob; name: string };
}): void {
  for (const file of resultFiles(result)) triggerDownload(file.blob, file.name);
}

