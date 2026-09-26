import { canEncodeAudio, getFirstEncodableAudioCodec, type AudioCodec } from 'mediabunny';

/**
 * The audio encoders the browser does not have.
 *
 * MP3 and FLAC have no encoder in WebCodecs on any platform — not on Chrome, not on
 * Safari, not anywhere — and AAC is missing on a good share of them (Firefox on Linux is
 * the usual example). Without these packages, "convert to MP3" is a target the router
 * offers and the engine then refuses, which is the exact shape of dishonesty this project
 * exists to avoid.
 *
 * Each package registers a WebAssembly encoder with the primary engine. They are 300 KB
 * to 1 MB, self-contained, and imported only when a conversion actually needs one — a
 * Chrome user converting MP4 to MKV never fetches any of them.
 *
 * Registration is synchronous and invalidates the library's capability memo, so asking
 * `canEncodeAudio` afterwards gives the true post-registration answer.
 */
const EXTENSIONS: Partial<Record<string, () => Promise<unknown>>> = {
  mp3: async () => (await import('@mediabunny/mp3-encoder')).registerMp3Encoder(),
  flac: async () => (await import('@mediabunny/flac-encoder')).registerFlacEncoder(),
  aac: async () => (await import('@mediabunny/aac-encoder')).registerAacEncoder(),
};

export interface AudioTarget {
  /** The codecs this container can hold, in the container's own preference order. */
  codecs: readonly string[];
  /** What the user asked for, if they asked for anything. */
  requested?: unknown;
  /** The real parameters the audio will be encoded at, when they are known. */
  params?: { numberOfChannels?: number; sampleRate?: number };
  /**
   * Called immediately before an extension is fetched, so the UI can say why a
   * conversion that was instant a moment ago is now waiting on a megabyte.
   */
  onLoad?: (codec: string) => void;
}

/**
 * Guarantee that at least one of the container's audio codecs can be encoded here.
 *
 * This mirrors what the engine itself does — walk the container's codecs in its own
 * order and take the first that can be encoded — narrowed to the user's pick when they
 * made one. Doing it *before* `Conversion.init` is the point: the library's own fallback
 * is to discard the track, and a video that quietly arrives without its soundtrack is
 * worse than one that failed.
 *
 * The real channel count and sample rate are passed through where known, because the
 * extension encoders accept a limited set of each (MP3 takes two channels and a handful
 * of rates). A probe with default parameters can say yes while the actual encode says no.
 *
 * @returns the codec that will be used, or `null` when nothing available can produce one.
 */
export async function primeAudioEncoder(target: AudioTarget): Promise<string | null> {
  const { codecs, requested, params, onLoad } = target;
  if (codecs.length === 0) return null;

  const candidates =
    typeof requested === 'string' && codecs.includes(requested) ? [requested] : [...codecs];

  const options = { ...params };
  const native = await getFirstEncodableAudioCodec(candidates as AudioCodec[], options);
  if (native) return native;

  // Nothing native. The extension packages are the only other source, and only three
  // codecs have one — anything else genuinely has no encoder here.
  for (const codec of candidates) {
    const load = EXTENSIONS[codec];
    if (!load) continue;

    onLoad?.(codec);
    try {
      await load();
    } catch {
      // A failed download is not fatal yet: the next candidate may still be encodable.
      continue;
    }

    if (await canEncodeAudio(codec as AudioCodec, options)) return codec;
  }

  return null;
}

/** Which codecs have a downloadable encoder. Used to explain a refusal precisely. */
export function hasExtension(codec: string): boolean {
  return codec in EXTENSIONS;
}
