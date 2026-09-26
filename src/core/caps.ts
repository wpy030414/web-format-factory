import { CODECS, PROBED_AUDIO_CODECS, PROBED_VIDEO_CODECS } from './codecs.ts';
import type { CodecId } from './types.ts';

/**
 * What this browser can actually do.
 *
 * Every answer here is *measured*, never inferred from a user-agent string. The whole
 * project rests on capability checks like these — a route is offered because the encoder
 * was probed and said yes, not because a browser was assumed to support something.
 *
 * Codec strings matter more than they look. `VideoEncoder.isConfigSupported` rejects a
 * bare `'vp9'` and accepts `'vp09.00.10.08'`; a probe written with the short name reports
 * VP9 as unavailable on a machine that encodes it perfectly well. Those strings live in
 * `codecs.ts` so there is exactly one of each.
 */

/** One codec's answer, keyed by our own codec id rather than by its display name. */
export type CodecTable = Partial<Record<CodecId, boolean>>;

export interface Capabilities {
  /** Required by the fallback engine, which fails silently without it. */
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  webWorkers: boolean;
  offscreenCanvas: boolean;
  /** WebCodecs' frame-level image API. Still preview-only in Safari. */
  imageDecoder: boolean;
  /** Can the browser decode HEIC itself? True on Safari 17+, false almost everywhere. */
  heicNative: boolean;

  videoEncode: CodecTable;
  videoDecode: CodecTable;
  audioEncode: CodecTable;
  audioDecode: CodecTable;
}

/** The encoder half of the report, which routing needs on its own. */
export interface EncoderCapabilities {
  video: CodecTable;
  audio: CodecTable;
}

/**
 * Ask the browser which codecs it can *encode*, and nothing else.
 *
 * Split out because routing needs this answer and none of the others, and the rest of the
 * report is not free: `probeHeic` fetches a real HEIC over the network. A planner that
 * pulled in the whole report would make every page load pay for a diagnostic it never
 * shows.
 */
export async function probeEncoders(): Promise<EncoderCapabilities> {
  return { video: await probeVideoEncoding(), audio: await probeAudioEncoding() };
}

/** Probe every capability the diagnostic page reports on. */
export async function probeCapabilities(): Promise<Capabilities> {
  const encoders = await probeEncoders();
  const videoDecode = await probeVideoDecoding();
  const audioDecode = await probeAudioDecoding();

  return {
    crossOriginIsolated: typeof self !== 'undefined' && self.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    webWorkers: typeof Worker !== 'undefined',
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    imageDecoder: typeof (globalThis as { ImageDecoder?: unknown }).ImageDecoder !== 'undefined',
    heicNative: await probeHeic(),
    videoEncode: encoders.video,
    audioEncode: encoders.audio,
    videoDecode,
    audioDecode,
  };
}

/** Codec strings for the list, skipping any the browser has no name for. */
function codecStrings(ids: readonly CodecId[]): Array<[CodecId, string]> {
  const out: Array<[CodecId, string]> = [];
  for (const id of ids) {
    const codec = CODECS[id]?.webcodecs;
    if (codec) out.push([id, codec]);
  }
  return out;
}

async function probeVideoEncoding(): Promise<CodecTable> {
  const Encoder = (globalThis as { VideoEncoder?: unknown }).VideoEncoder;
  if (typeof Encoder !== 'function') return allFalse(PROBED_VIDEO_CODECS);

  const out: CodecTable = {};
  for (const [id, codec] of codecStrings(PROBED_VIDEO_CODECS)) {
    out[id] = await isSupported(Encoder, {
      // Real dimensions and a real bitrate: a probe with placeholder values answers a
      // different question than the one being asked.
      codec,
      width: 1280,
      height: 720,
      bitrate: 2_000_000,
      framerate: 30,
    });
  }
  return out;
}

async function probeVideoDecoding(): Promise<CodecTable> {
  const Decoder = (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
  if (typeof Decoder !== 'function') return allFalse(PROBED_VIDEO_CODECS);

  const out: CodecTable = {};
  for (const [id, codec] of codecStrings(PROBED_VIDEO_CODECS)) {
    out[id] = await isSupported(Decoder, { codec });
  }
  return out;
}

async function probeAudioEncoding(): Promise<CodecTable> {
  const Encoder = (globalThis as { AudioEncoder?: unknown }).AudioEncoder;
  if (typeof Encoder !== 'function') return allFalse(PROBED_AUDIO_CODECS);

  const out: CodecTable = {};
  for (const [id, codec] of codecStrings(PROBED_AUDIO_CODECS)) {
    out[id] = await isSupported(Encoder, {
      codec,
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 128_000,
    });
  }
  return out;
}

async function probeAudioDecoding(): Promise<CodecTable> {
  const Decoder = (globalThis as { AudioDecoder?: unknown }).AudioDecoder;
  if (typeof Decoder !== 'function') return allFalse(PROBED_AUDIO_CODECS);

  const out: CodecTable = {};
  for (const [id, codec] of codecStrings(PROBED_AUDIO_CODECS)) {
    out[id] = await isSupported(Decoder, {
      codec,
      sampleRate: 48000,
      numberOfChannels: 2,
    });
  }
  return out;
}

async function isSupported(
  ctor: unknown,
  config: Record<string, unknown>,
): Promise<boolean> {
  try {
    const result = await (
      ctor as { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> }
    ).isConfigSupported(config);
    return result.supported === true;
  } catch {
    // A rejected config means "no", not "unknown".
    return false;
  }
}

/**
 * Can the browser decode HEIC on its own?
 *
 * Answered by handing it a real HEIC rather than by checking a version number: Safari
 * decodes it, every other engine refuses, and the difference decides whether the app
 * needs its WASM decoder on this machine at all.
 */
async function probeHeic(): Promise<boolean> {
  if (typeof createImageBitmap !== 'function') return false;
  try {
    const response = await fetch('/probe/heic.heic', { cache: 'force-cache' });
    if (!response.ok) return false;
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    bitmap.close();
    return true;
  } catch {
    return false;
  }
}

function allFalse(ids: readonly CodecId[]): CodecTable {
  return Object.fromEntries(ids.map((id) => [id, false])) as CodecTable;
}
