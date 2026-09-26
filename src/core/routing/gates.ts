import type { CodecId, FormatId } from '../types.ts';
import type { MediaProfile } from '../probe/profile.ts';
import { changedParams, getFormat } from '../registry/formats.ts';
import { codecLabel } from '../codecs.ts';
import type { Verdict } from './transitions.ts';

/**
 * What this machine can actually run, in the respects routing cares about.
 *
 * Deliberately narrower than `Capabilities`. That type is the diagnostic page's whole
 * report — worth *showing* in full, but almost none of it changes what may be offered.
 * These do: each decides whether some engine can reach a target at all, so a route that
 * ignores one is a button that fails at the end of the job instead of a button that
 * explains itself.
 *
 * Two of them are facts about the environment that can simply be read; the third has to
 * be measured, which is why it is allowed to be absent.
 */
export interface RouteCapabilities {
  /**
   * WebCodecs' frame-level image API.
   *
   * The only way to take an animated WebP or APNG apart. The media library cannot read
   * either — they are images, not videos — and no JS package decodes their frames.
   */
  imageDecoder: boolean;
  /**
   * Whether the fallback engine can run at all.
   *
   * Checked because ffmpeg.wasm does not *fail* without it; it hangs, which is a far worse
   * way for a conversion to go wrong.
   */
  crossOriginIsolated: boolean;
  /**
   * The codecs this build can produce, or `null` before the probe has answered.
   *
   * `null` is a state of its own and is not the empty set: an unmeasured machine is not a
   * machine without encoders. The window it covers is the one between the page mounting
   * and the probe landing, and no file can be in it — a file requires someone to drop one,
   * and probing that file takes longer than this does.
   */
  encodable: ReadonlySet<CodecId> | null;
}

/**
 * Read the part of it that needs no measuring.
 *
 * These answers are synchronous — an API's presence and a flag on `self` — so the planner
 * never has to wait for a probe before it can say what it offers, and the store can hold
 * them from the first render. `encodable` is not among them: it takes `isConfigSupported`,
 * which is async, so the store probes it and folds the answer in. Both halves describe the
 * same machine the diagnostic page reports on; that page and the picker must never
 * disagree.
 */
export function readRouteCapabilities(): RouteCapabilities {
  return {
    imageDecoder: typeof (globalThis as { ImageDecoder?: unknown }).ImageDecoder !== 'undefined',
    crossOriginIsolated: typeof self !== 'undefined' && self.crossOriginIsolated === true,
    encodable: null,
  };
}

/** A route the semantics allow but this machine cannot run. */
export interface ShutGate {
  /** Drawn from the existing impossibility vocabulary rather than invented anew. */
  reason: 'no-decoder-in-browser' | 'no-encoder-in-browser' | 'engine-unavailable';
  /** A noun phrase the reason's copy slots into its sentence. */
  detail: string;
}

/** Everything a door is allowed to look at. */
export interface GateContext {
  profile: Pick<MediaProfile, 'mediaClass' | 'container' | 'videoTracks' | 'audioTracks'>;
  target: FormatId;
  params: Readonly<Record<string, unknown>>;
  caps: RouteCapabilities;
  verdict: Verdict;
  /**
   * Will the encoded bytes be carried over untouched?
   *
   * The codec doors turn on this: a container change copies the packets and decodes
   * nothing, so asking whether this machine can decode them would be asking a question
   * whose answer does not bear on the job.
   */
  copyable: boolean;
}

type Door = (ctx: GateContext) => ShutGate | null;

/**
 * Every door a route has to get through, cheapest question first.
 *
 * Split out from `verdictFor()` on purpose. That function answers what is *possible*, and
 * its answers are the same on every machine — which is what makes the exhaustive 225-pair
 * snapshot test worth having. These answer what is possible *here*, and they are the layer
 * the UI's disabled buttons and their reasons come from.
 *
 * Order matters when more than one is shut: the first one reported should be the one that
 * would stop the job first, so the reason shown is the one worth acting on.
 */
const DOORS: readonly Door[] = [fallbackEngineDoor, imageDecoderDoor, decoderDoor, encoderDoor];

export function shutGate(ctx: GateContext): ShutGate | null {
  for (const door of DOORS) {
    const shut = door(ctx);
    if (shut) return shut;
  }
  return null;
}

/* ------------------------------------------------------------------ the doors */

/**
 * Targets with no writer outside the fallback engine.
 *
 * The ffmpeg whitelist in `docs/specs/engine-routing.md`, minus the two entries that
 * depend on the source rather than the target:
 *
 * - animated WebP and APNG have no maintained JS encoder, so the fallback engine is the
 *   only thing that can write them;
 * - Apple's pairing identifier has to go into a QuickTime `keys`/`ilst` atom, which the
 *   primary engine silently drops — see ADR-004. Motion Photo deliberately does *not*
 *   appear here: it is pure byte work and needs neither the engine nor isolation.
 */
const FFMPEG_ONLY_TARGETS: ReadonlySet<FormatId> = new Set<FormatId>([
  'webp-anim',
  'apng',
  'live-photo',
]);

const FFMPEG_SHUT: ShutGate = {
  reason: 'engine-unavailable',
  detail: '兜底引擎（ffmpeg）',
};

function fallbackEngineDoor({ target, params, caps }: GateContext): ShutGate | null {
  if (caps.crossOriginIsolated) return null;
  if (FFMPEG_ONLY_TARGETS.has(target)) return FFMPEG_SHUT;

  // Ogg's Vorbis encoder lives there too. Unlike the three above this one is a parameter
  // rather than the target: the same Ogg target defaults to Opus, which the primary
  // engine writes with no engine download at all.
  if (target === 'ogg' && params.codec === 'vorbis') return FFMPEG_SHUT;

  return null;
}

/**
 * Targets reachable only by taking a frame sequence apart with the browser's own decoder.
 *
 * An animated WebP or APNG is not a video, so the media library refuses it, and no other
 * engine can read one. The exceptions are narrow and worth stating, because a gate that
 * fires too wide disables routes that work:
 *
 * - the still-image targets need a single frame, which `createImageBitmap` hands over
 *   without WebCodecs;
 * - `webp-anim` and `apng` are written by the fallback engine, which decodes those very
 *   formats itself.
 *
 * GIF is absent by construction — its frames come from the GIF library, not from here.
 */
const IMAGE_DECODER_ONLY_TARGETS: ReadonlySet<FormatId> = new Set<FormatId>([
  'gif',
  'mp4',
  'mov',
  'mkv',
  'webm',
  'live-photo',
  'motion-photo',
]);

/** Containers holding a frame sequence with no track structure: the browser-only cases. */
const IMAGE_DECODER_CONTAINERS: ReadonlySet<string> = new Set(['webp', 'png']);

function imageDecoderDoor({ profile, target, caps }: GateContext): ShutGate | null {
  if (caps.imageDecoder) return null;
  if (profile.mediaClass !== 'animated-image') return null;
  if (!IMAGE_DECODER_CONTAINERS.has(profile.container)) return null;
  if (!IMAGE_DECODER_ONLY_TARGETS.has(target)) return null;

  return { reason: 'no-decoder-in-browser', detail: '动态 WebP / APNG 的帧序列' };
}

/**
 * The source has to be taken apart before it can be put back together.
 *
 * `decodable` is measured per track when the file is probed, by putting the media
 * library's own question to it — the same one it will ask again when the job runs. So
 * this is the library's answer rather than a guess from a codec name, and the two can
 * never disagree. Until this door existed the field was measured and then read by nobody:
 * the profile's comment promised a `no-decoder-in-browser` refusal that no code produced.
 *
 * Three exclusions, each because a door that fires too wide disables routes that work —
 * the mirror image of the failure doors exist to prevent:
 *
 * - a container change copies the packets and decodes nothing;
 * - exporting the still half of a bundle never touches its video, so an HEVC Live Photo
 *   must still export its JPEG on a browser that cannot decode HEVC;
 * - a target that carries no sound never needs the source's audio decoded, which is why
 *   a video with an unreadable soundtrack can still become a GIF.
 */
function decoderDoor({ profile, target, verdict, copyable }: GateContext): ShutGate | null {
  if (copyable) return null;
  if (verdict.kind === 'project' && verdict.projector === 'split-still') return null;

  const spec = getFormat(target);
  const needed = [
    ...profile.videoTracks,
    ...(spec.codecs.audio?.length ? profile.audioTracks : []),
  ];

  const blocked = needed.find((track) => !track.decodable);
  if (!blocked) return null;

  return { reason: 'no-decoder-in-browser', detail: codecLabel(blocked.codec) };
}

/**
 * A codec the user asked for by name, that this machine cannot produce.
 *
 * Only ever about a codec the user *chose*. When they choose nothing, the engine decides
 * for itself — it walks the target's codec list and takes the first one it can encode — so
 * there is no decision to second-guess and nothing to refuse. A named codec is different:
 * the engine will use exactly that one, and if this machine cannot encode it the job dies
 * at the end. The H.265 option says as much out loud in its own label —
 * 「更小，但只有 Apple 端能编码」 — and a control that admits it might not work is a control
 * that should have been disabled.
 *
 * The names that can be chosen are all browser questions — see the registry's `codec`
 * options — which is what makes the probed set the right thing to ask. The one exception
 * is Vorbis, and its door has already ruled on it.
 */
function encoderDoor({ target, params, caps }: GateContext): ShutGate | null {
  // A codec the user actually *chose*, which is not the same as one that is merely
  // present: the panel seeds every control with its declared default, so a codec sitting
  // at its default is in `params` without being a decision — and `changedParams` is what
  // the engine itself reads to decide whether to force a re-encode.
  const chosen = changedParams(target, params).codec;
  if (typeof chosen !== 'string') return null;
  if (!caps.encodable) return null;

  // Vorbis is the fallback engine's to write, and that door has already decided — it only
  // ever shuts when isolation is missing. Repeating the judgement here would report a
  // missing browser encoder for something the browser was never going to be asked to do.
  if (target === 'ogg' && chosen === 'vorbis') return null;

  if (caps.encodable.has(chosen as CodecId)) return null;

  return { reason: 'no-encoder-in-browser', detail: codecLabel(chosen) };
}
