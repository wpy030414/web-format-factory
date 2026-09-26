/**
 * What this browser can actually do.
 *
 * Every answer here is *measured*, never inferred from a user-agent string. The whole
 * project rests on capability checks like these — a route is offered because the encoder
 * was probed and said yes, not because a browser was assumed to support something.
 *
 * Codec strings matter more than they look. `VideoEncoder.isConfigSupported` rejects a
 * bare `'vp9'` and accepts `'vp09.00.10.08'`; a probe written with the short name reports
 * VP9 as unavailable on a machine that encodes it perfectly well.
 */

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

  videoEncode: Record<string, boolean>;
  videoDecode: Record<string, boolean>;
  audioEncode: Record<string, boolean>;
  audioDecode: Record<string, boolean>;
}

/**
 * Codec strings to probe, with the form the browser actually expects.
 *
 * H.264 needs a profile/level suffix and nothing else will do. The values are the
 * widely-supported Main profile at level 3.1 and 5.2 respectively.
 */
const VIDEO_CODECS: Record<string, string> = {
  'H.264': 'avc1.42001f',
  'H.265': 'hvc1.1.6.L93.B0',
  VP8: 'vp8',
  VP9: 'vp09.00.10.08',
  AV1: 'av01.0.05M.08',
};

const AUDIO_CODECS: Record<string, string> = {
  AAC: 'mp4a.40.2',
  Opus: 'opus',
  MP3: 'mp3',
  FLAC: 'flac',
  Vorbis: 'vorbis',
};

/** Probe every capability this page reports on. */
export async function probeCapabilities(): Promise<Capabilities> {
  const videoEncode = await probeVideoEncoding();
  const videoDecode = await probeVideoDecoding();
  const audioEncode = await probeAudioEncoding();
  const audioDecode = await probeAudioDecoding();

  return {
    crossOriginIsolated: typeof self !== 'undefined' && self.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    webWorkers: typeof Worker !== 'undefined',
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    imageDecoder: typeof (globalThis as { ImageDecoder?: unknown }).ImageDecoder !== 'undefined',
    heicNative: await probeHeic(),
    videoEncode,
    videoDecode,
    audioEncode,
    audioDecode,
  };
}

async function probeVideoEncoding(): Promise<Record<string, boolean>> {
  const Encoder = (globalThis as { VideoEncoder?: unknown }).VideoEncoder;
  if (typeof Encoder !== 'function') return allFalse(VIDEO_CODECS);

  const out: Record<string, boolean> = {};
  for (const [label, codec] of Object.entries(VIDEO_CODECS)) {
    out[label] = await isSupported(Encoder, {
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

async function probeVideoDecoding(): Promise<Record<string, boolean>> {
  const Decoder = (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
  if (typeof Decoder !== 'function') return allFalse(VIDEO_CODECS);

  const out: Record<string, boolean> = {};
  for (const [label, codec] of Object.entries(VIDEO_CODECS)) {
    out[label] = await isSupported(Decoder, { codec });
  }
  return out;
}

async function probeAudioEncoding(): Promise<Record<string, boolean>> {
  const Encoder = (globalThis as { AudioEncoder?: unknown }).AudioEncoder;
  if (typeof Encoder !== 'function') return allFalse(AUDIO_CODECS);

  const out: Record<string, boolean> = {};
  for (const [label, codec] of Object.entries(AUDIO_CODECS)) {
    out[label] = await isSupported(Encoder, {
      codec,
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 128_000,
    });
  }
  return out;
}

async function probeAudioDecoding(): Promise<Record<string, boolean>> {
  const Decoder = (globalThis as { AudioDecoder?: unknown }).AudioDecoder;
  if (typeof Decoder !== 'function') return allFalse(AUDIO_CODECS);

  const out: Record<string, boolean> = {};
  for (const [label, codec] of Object.entries(AUDIO_CODECS)) {
    out[label] = await isSupported(Decoder, {
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

function allFalse(codes: Record<string, string>): Record<string, boolean> {
  return Object.fromEntries(Object.keys(codes).map((k) => [k, false]));
}
