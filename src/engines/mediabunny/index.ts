import {
  ADTS,
  AdtsOutputFormat,
  BlobSource,
  BufferTarget,
  Conversion,
  FLAC,
  FlacOutputFormat,
  Input,
  MATROSKA,
  MkvOutputFormat,
  MP3,
  MP4,
  Mp3OutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  Quality,
  OGG,
  OggOutputFormat,
  Output,
  QTFF,
  WAVE,
  WEBM,
  WavOutputFormat,
  WebMOutputFormat,
  type InputFormat,
  type OutputFormat,
} from 'mediabunny';

import { changedParams, getFormat } from '../../core/registry/formats.ts';
import { severityOf, type LossItem } from '../../core/loss/codes.ts';
import type { FormatId } from '../../core/types.ts';
import {
  EngineError,
  outputNameFor,
  type Engine,
  type EngineRequest,
  type EngineResult,
} from '../types.ts';

/**
 * Container formats this engine can read.
 *
 * Enumerated explicitly rather than using `ALL_FORMATS`: Mediabunny is tree-shakeable,
 * and registering parsers we never use (HLS, MPEG-TS, CMAF) costs bundle for nothing.
 */
const INPUT_FORMATS: InputFormat[] = [MP4, QTFF, MATROSKA, WEBM, OGG, MP3, ADTS, FLAC, WAVE];

/**
 * Container formats this engine can write.
 *
 * Every target container in both format lines is here — verified against the library's
 * own type definitions rather than its documentation.
 */
const WRITERS: Partial<Record<FormatId, () => OutputFormat>> = {
  mp4: () => new Mp4OutputFormat(),
  mov: () => new MovOutputFormat(),
  mkv: () => new MkvOutputFormat(),
  webm: () => new WebMOutputFormat(),
  // M4A is MP4 with an audio-only track set; the brand follows from the track contents.
  m4a: () => new Mp4OutputFormat(),
  mp3: () => new Mp3OutputFormat(),
  wav: () => new WavOutputFormat(),
  flac: () => new FlacOutputFormat(),
  ogg: () => new OggOutputFormat(),
  aac: () => new AdtsOutputFormat(),
};

/**
 * Decide whether a conversion can be a pure container change, or must re-encode.
 *
 * This has to be decided by *querying the codecs*, not by looking at whether the user
 * passed any parameters. The distinction matters in both directions:
 *
 *   - WAV → FLAC has no parameters, and yet PCM cannot be stored in a FLAC container,
 *     so it must transcode. Assuming "no params means a copy" makes it fail outright.
 *   - MP4 → MKV has no parameters and *can* be copied, so it must not transcode.
 *   - MP4 → WebM is a legitimate conversion, but H.264 cannot live in a WebM container,
 *     so it transcodes to VP9 rather than being refused.
 *
 * Getting this wrong is not a small bug: `copy: 'forced'` *discards* tracks that cannot
 * be copied, so a mis-planned conversion silently produces a file missing a track.
 */
export interface CopyDecision {
  /** What to tell Mediabunny. */
  mode: 'forced' | 'preferred';
  /** What we expect to happen, reported to the user afterwards. */
  did: 'transmux' | 'transcode';
  /** Codecs that cannot be carried over, when a transcode is required. */
  incompatible: string[];
}

export async function planCopy(
  input: Input,
  outputFormat: OutputFormat,
  params: Readonly<Record<string, unknown>> = {},
  target?: FormatId,
): Promise<CopyDecision> {
  const supported = new Set<string>(outputFormat.getSupportedCodecs());

  const tracks = await input.getTracks();
  const incompatible: string[] = [];
  for (const track of tracks) {
    const codec = await track.getCodec();
    // A null codec means we could not identify it, which we must not assume is copyable.
    if (codec === null || !supported.has(codec)) {
      incompatible.push(codec ?? `${track.type}:unknown`);
    }
  }

  // An explicit request to re-encode always wins over the automatic choice — but only a
  // request that was actually made. The UI seeds every control with its default, so a
  // present `codec` on an untouched conversion means nothing; treating it as a choice
  // would re-encode everything and quietly turn a lossless container change into a
  // generation loss.
  const chosen = target ? changedParams(target, params) : params;
  const userForced =
    chosen.forceTranscode === true ||
    chosen.codec !== undefined ||
    chosen.quality !== undefined ||
    chosen.bitrate !== undefined;

  if (userForced || incompatible.length > 0 || tracks.length === 0) {
    return { mode: 'preferred', did: 'transcode', incompatible };
  }
  return { mode: 'forced', did: 'transmux', incompatible };
}

/**
 * Build the per-track encode options from the user's parameters.
 *
 * Without this the parameters reach the *plan* but never the encoder: `copy: 'preferred'`
 * means "copy whatever can be copied", so choosing VP9 for a Matroska target would
 * happily copy the source's H.264 instead and the setting would be silently ignored —
 * the panel would say one thing and the file another.
 *
 * `forceTranscode` is what turns a preference into an instruction. It is applied only
 * when the user actually changed something: asking for the codec a track already has
 * should still be allowed to copy it.
 *
 * @returns the `video` / `audio` entries for `ConversionOptions`.
 */
function trackOptionsFor(
  target: FormatId,
  params: Readonly<Record<string, unknown>>,
): { video?: Record<string, unknown>; audio?: Record<string, unknown> } {
  const chosen = changedParams(target, params);
  const spec = getFormat(target);

  const videoChanges: Record<string, unknown> = {};
  const audioChanges: Record<string, unknown> = {};

  // The same `codec` parameter means a picture codec on some targets and a sound codec
  // on others, so which track it belongs to is decided by the target's own declaration.
  if (typeof chosen.codec === 'string') {
    if ((spec.codecs.video ?? []).includes(chosen.codec as never)) videoChanges.codec = chosen.codec;
    else if ((spec.codecs.audio ?? []).includes(chosen.codec as never)) {
      audioChanges.codec = chosen.codec;
    }
  }

  if (typeof chosen.quality === 'number') {
    // Quality applies to whichever track the target has.
    if (spec.codecs.video?.length) videoChanges.quality = new Quality(chosen.quality);
    else if (spec.codecs.audio?.length) audioChanges.quality = new Quality(chosen.quality);
  }

  if (typeof chosen.keyFrameInterval === 'number') {
    videoChanges.keyFrameInterval = chosen.keyFrameInterval;
  }
  if (typeof chosen.hardwareAcceleration === 'string') {
    videoChanges.hardwareAcceleration = chosen.hardwareAcceleration;
  }
  if (chosen.alpha === 'keep' || chosen.alpha === 'discard') {
    videoChanges.alpha = chosen.alpha;
  }

  // A request to re-encode has to be *forced*, not merely preferred. `preferred` asks
  // the library to copy anything copyable, which would defeat an explicit codec choice
  // whenever the source codec happens to fit the target container.
  const forced =
    chosen.forceTranscode === true ||
    chosen.codec !== undefined ||
    chosen.quality !== undefined ||
    chosen.bitrate !== undefined;

  if (forced) {
    if (Object.keys(videoChanges).length > 0) videoChanges.forceTranscode = true;
    else if (spec.codecs.video?.length) videoChanges.forceTranscode = true;
    if (Object.keys(audioChanges).length > 0) audioChanges.forceTranscode = true;
  }

  const video = Object.keys(videoChanges).length > 0 ? videoChanges : undefined;
  const audio = Object.keys(audioChanges).length > 0 ? audioChanges : undefined;
  return { ...(video ? { video } : {}), ...(audio ? { audio } : {}) };
}

/**
 * The primary engine: Mediabunny driving WebCodecs.
 *
 * Its default behaviour — copy the encoded packets when the target container can hold
 * them, transcoding only when it cannot — is exactly the "lossless and near-instant
 * where possible" property we want. A pure container change needs no WebCodecs at all,
 * which also makes the transmux path testable outside a browser.
 */
export class MediabunnyEngine implements Engine {
  readonly id = 'mediabunny';

  supports(target: FormatId): boolean {
    return target in WRITERS;
  }

  async run(request: EngineRequest): Promise<EngineResult> {
    const { input, target, params, signal, onProgress } = request;

    const makeWriter = WRITERS[target];
    if (!makeWriter) throw new EngineError(`no writer for ${target}`, 'unsupported');

    const outputFormat = makeWriter();

    let mediaInput: Input;
    let decision: CopyDecision;
    try {
      mediaInput = new Input({ source: new BlobSource(input), formats: INPUT_FORMATS });
      decision = await planCopy(mediaInput, outputFormat, params, target);
    } catch (cause) {
      // A source this engine cannot parse is not a failure — it is the signal for the
      // dispatcher to fall through to the next engine.
      //
      // The library throws its own error type here, with no `unsupported` marker of its
      // own, so without this translation the fall-through never fires. That is exactly
      // how GIF → video broke: Mediabunny claims the video containers, could not read
      // the GIF, and the animation engine behind it was never consulted.
      throw new EngineError(
        `无法解析这个来源：${(cause as Error).message}`,
        'unsupported',
      );
    }

    const target0 = new BufferTarget();
    const output = new Output({ format: outputFormat, target: target0 });

    let conversion: Conversion;
    try {
      conversion = await Conversion.init({
        input: mediaInput,
        output,
        copy: { mode: decision.mode },
        // The user's settings, translated into per-track encode options. Without these
        // the parameters change the plan but never the output.
        ...trackOptionsFor(target, params),
        // Carry the source's metadata across. Dropping it silently would be a content
        // loss the user never agreed to — see docs/DECISIONS.md ADR-003.
        tags: (inputTags) => inputTags,
      });
    } catch (cause) {
      throw new EngineError(
        `could not plan the conversion: ${(cause as Error).message}`,
        'unsupported',
      );
    }

    if (!conversion.isValid) {
      // Surface *why*, because "cannot be converted" alone gives the user nothing to act on.
      const why = conversion.discardedTracks
        .map((d) => `${d.track.type}: ${d.reason}`)
        .join(', ');
      throw new EngineError(
        why
          ? `this source cannot be converted to the chosen target (${why})`
          : 'this source cannot be converted to the chosen target',
        'unsupported',
      );
    }

    const onAbort = () => void conversion.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });

    // `onProgress` is an assignable property that must be set before `execute()`.
    conversion.onProgress = (ratio) => {
      onProgress?.({ phase: 'muxing', ratio });
    };

    try {
      await conversion.execute();
    } catch (cause) {
      if (signal?.aborted) throw new EngineError('conversion cancelled', 'aborted');
      throw new EngineError(`conversion failed: ${(cause as Error).message}`, 'encode-failed');
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    const buffer = target0.buffer;
    if (!buffer) throw new EngineError('conversion produced no output', 'encode-failed');

    // Report what actually happened, which may differ from what was asked for. A copy
    // that silently discarded a track is precisely what the result report exists to
    // surface, so these become real loss items rather than a log line.
    const extraLosses: LossItem[] = conversion.discardedTracks.map((d) => ({
      code: 'extra-tracks-dropped' as const,
      severity: severityOf('extra-tracks-dropped'),
      detail: `${d.track.type} track (${d.reason})`,
    }));

    const spec = getFormat(target);

    return {
      output: new Blob([buffer], { type: spec.mime }),
      outputName: outputNameFor(request.inputName, spec.extension),
      engineId: this.id,
      did: decision.did,
      ...(extraLosses.length > 0 ? { extraLosses } : {}),
    };
  }
}
