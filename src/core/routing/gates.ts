import type { FormatId } from '../types.ts';
import type { MediaProfile } from '../probe/profile.ts';

/**
 * What this machine can actually run, in the only two respects routing cares about.
 *
 * Deliberately narrower than `Capabilities`. That type answers "what is this machine
 * like" for the diagnostic page, and almost all of it is worth *reporting* without
 * changing what may be offered. These two are different in kind: each one decides whether
 * some engine can reach a target at all, so a route that ignores them is a button that
 * fails at the end of the job instead of a button that explains itself.
 *
 * `Capabilities` structurally satisfies this, so the diagnostic page's full probe can be
 * handed straight to the planner.
 */
export interface RouteCapabilities {
  /**
   * WebCodecs' frame-level image API.
   *
   * The only way to take an animated WebP or APNG apart. MEDIABUNNY cannot read either —
   * they are images, not videos — and no JS package encodes or decodes their frames.
   */
  imageDecoder: boolean;
  /**
   * Whether the fallback engine can run at all.
   *
   * Checked because ffmpeg.wasm does not *fail* without it; it hangs, which is a far worse
   * way for a conversion to go wrong.
   */
  crossOriginIsolated: boolean;
}

/**
 * Read the two gates off the environment.
 *
 * Both answers are synchronous — an API's presence and a flag on `self` — so the planner
 * never has to wait for a probe before it can say what it offers, and the store can hold
 * them from the first render. They are the same facts the diagnostic page reports; that
 * page and the picker must never disagree.
 */
export function readRouteCapabilities(): RouteCapabilities {
  return {
    imageDecoder: typeof (globalThis as { ImageDecoder?: unknown }).ImageDecoder !== 'undefined',
    crossOriginIsolated: typeof self !== 'undefined' && self.crossOriginIsolated === true,
  };
}

/** A route the semantics allow but this machine cannot run. */
export interface ShutGate {
  /** Drawn from the existing impossibility vocabulary rather than invented anew. */
  reason: 'no-decoder-in-browser' | 'engine-unavailable';
  /** A noun phrase the reason's copy slots into its sentence. */
  detail: string;
}

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

/**
 * The gate, if one is shut for this route.
 *
 * Split out from `verdictFor()` on purpose. That function answers what is *possible*, and
 * its answers are the same on every machine — which is what makes the exhaustive
 * 225-pair snapshot test worth having. This one answers what is possible *here*, and it
 * is the layer the UI's disabled buttons and their reasons come from.
 */
export function shutGate(
  profile: Pick<MediaProfile, 'mediaClass' | 'container'>,
  target: FormatId,
  params: Readonly<Record<string, unknown>>,
  caps: RouteCapabilities,
): ShutGate | null {
  if (!caps.crossOriginIsolated) {
    if (FFMPEG_ONLY_TARGETS.has(target)) return FFMPEG_SHUT;

    // Ogg's Vorbis encoder lives there too. Unlike the three above this one is a
    // parameter rather than the target: the same Ogg target defaults to Opus, which the
    // primary engine writes with no engine download at all.
    if (target === 'ogg' && params.codec === 'vorbis') return FFMPEG_SHUT;
  }

  return decoderGate(profile, target, caps);
}

const FFMPEG_SHUT: ShutGate = {
  reason: 'engine-unavailable',
  detail: '兜底引擎（ffmpeg）',
};

function decoderGate(
  profile: Pick<MediaProfile, 'mediaClass' | 'container'>,
  target: FormatId,
  caps: RouteCapabilities,
): ShutGate | null {
  if (caps.imageDecoder) return null;
  if (profile.mediaClass !== 'animated-image') return null;
  if (!IMAGE_DECODER_CONTAINERS.has(profile.container)) return null;
  if (!IMAGE_DECODER_ONLY_TARGETS.has(target)) return null;

  return {
    reason: 'no-decoder-in-browser',
    detail: '动态 WebP / APNG 的帧序列',
  };
}
