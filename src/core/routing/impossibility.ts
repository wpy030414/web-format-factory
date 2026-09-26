import type { FormatId, ImpossibilityReason } from '../types.ts';

export interface Impossibility {
  reason: ImpossibilityReason;
  /** Computed specifics, e.g. which codec is missing. */
  detail?: string;
  /**
   * Formats that WOULD work, so the UI can offer a real button instead of a dead end.
   * Empty only when nothing can be done — in which case the copy says so plainly.
   */
  alternatives: readonly FormatId[];
}

export interface ImpossibilityCopy {
  title: string;
  body: (i: Impossibility) => string;
}

/**
 * Copy for every way a conversion can be unavailable.
 *
 * The guiding rule: a disabled control must explain *why*, and whenever a different
 * target would work, the UI offers that target as a button — the alternatives are
 * rendered as controls, never folded into the prose.
 *
 * Where nothing can be done, we say so without hedging. Audio genuinely has no visual
 * component, and inventing one would be creation, not conversion.
 */
export const IMPOSSIBILITY_COPY: Record<ImpossibilityReason, ImpossibilityCopy> = {
  'class-mismatch': {
    title: 'Not applicable to this file',
    body: () => 'This conversion does not apply to the kind of file you dropped in.',
  },

  'needs-visual-component': {
    title: 'Audio has no pictures',
    body: () =>
      'A video needs a picture track, and audio does not contain one. Producing a video ' +
      'here would mean inventing visuals — that is authoring, not converting. ' +
      'Try an audio format instead.',
  },

  'needs-motion-component': {
    title: 'A still image has no motion',
    body: () =>
      'A Live Photo is defined as a still plus a short video. A single image cannot supply ' +
      'the video half. Drop the matching video alongside the image and we can pair them.',
  },

  'needs-multiple-frames': {
    title: 'A single frame is not an animation',
    body: () =>
      'An animated format needs a sequence of frames. One still image cannot be stretched ' +
      'into motion without inventing the missing frames. Try a still image format instead.',
  },

  'livephoto-needs-video': {
    title: 'Live Photo needs a video too',
    body: () =>
      'A Live Photo pairs a still image with a short video that share an identifier. ' +
      'A still image on its own has no video half to pair with.',
  },

  'no-encoder-in-browser': {
    title: 'This browser cannot encode that format',
    body: (i) =>
      `Your browser has no encoder for ${i.detail ?? 'the selected format'}. ` +
      'This is a limitation of the browser, not a problem with your file.',
  },

  'no-decoder-in-browser': {
    title: 'This file cannot be decoded here',
    body: (i) =>
      `Your browser cannot decode ${i.detail ?? 'this file'}. ` +
      'Try a different browser, or convert it with a desktop tool first.',
  },

  'container-cannot-hold-codec': {
    title: 'That container cannot hold this codec',
    body: (i) =>
      `${i.detail ?? 'The selected codec'} cannot be stored in the chosen container. ` +
      'Pick a different codec or a different container.',
  },

  'param-unsupported': {
    title: 'That setting is not available for this target',
    body: (i) => `${i.detail ?? 'The requested setting'} cannot be honoured by this format.`,
  },

  'engine-unavailable': {
    title: 'Required engine unavailable',
    body: (i) =>
      `${i.detail ?? 'An engine this conversion needs'} could not be loaded. ` +
      'This usually means the page is not cross-origin isolated, which the fallback ' +
      'engine requires.',
  },
};
