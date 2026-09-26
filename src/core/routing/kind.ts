import type { ConversionKind, RouteShape } from '../types.ts';

/**
 * Derive the conversion kind from two orthogonal axes.
 *
 * We never *declare* a kind. A declared kind can silently disagree with what the
 * pipeline actually does; a derived one cannot. `expectedKind` on a strategy exists
 * purely so a dev-mode assertion can catch a mismatch between intent and reality.
 */
export function kindOf(shape: RouteShape): ConversionKind {
  if (shape.mediaClass === 'changed') return 'projection';
  return shape.payload === 'preserved' ? 'transmux' : 'transcode';
}

/** Did the compressed payload survive untouched? */
export function isLosslessPayload(shape: RouteShape): boolean {
  return shape.payload === 'preserved';
}
