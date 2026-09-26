/**
 * JPEG marker-segment plumbing, shared by the XMP and EXIF writers.
 *
 * Both writers need the same three things — walk the segments, find where a new APP1 can
 * go, and splice one in — so the code lives here once rather than in each of them. That is
 * not tidiness for its own sake: a duplicated offset calculation is how this project
 * previously shipped a wrong quality scale (docs/DECISIONS.md ADR-011).
 */

/** JPEG segment markers we care about. */
export const MARKER_APP0 = 0xe0;
export const MARKER_APP1 = 0xe1;
export const MARKER_SOS = 0xda; // start of scan — everything after is entropy-coded
export const MARKER_EOI = 0xd9;

/** APP1 payloads are length-prefixed by two bytes, so this is the hard ceiling. */
export const MAX_APP1_PAYLOAD = 65533;

export interface JpegSegment {
  marker: number;
  /** Offset of the marker's 0xFF byte. */
  start: number;
  /** Offset just past the segment. */
  end: number;
  /** The segment's payload, excluding the length field. */
  payload: Uint8Array;
}

/** Walk a JPEG's marker segments up to the scan. Returns them in file order. */
export function readJpegSegments(bytes: Uint8Array): JpegSegment[] {
  const out: JpegSegment[] = [];
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return out; // not a JPEG

  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break; // desynchronised; stop rather than guess
    const marker = bytes[offset + 1]!;

    // Padding and standalone markers carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === MARKER_EOI || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === MARKER_SOS) {
      out.push({ marker, start: offset, end: bytes.length, payload: bytes.subarray(offset + 2) });
      break;
    }

    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) break;

    out.push({
      marker,
      start: offset,
      end: offset + 2 + length,
      payload: bytes.subarray(offset + 4, offset + 2 + length),
    });
    offset += 2 + length;
  }

  return out;
}

/** The segment with the given APP1 payload prefix, if the JPEG carries one. */
export function findApp1(
  segments: readonly JpegSegment[],
  payloadPrefix: Uint8Array,
): JpegSegment | undefined {
  return segments.find((segment) => {
    if (segment.marker !== MARKER_APP1 || segment.payload.length < payloadPrefix.length) {
      return false;
    }
    for (let i = 0; i < payloadPrefix.length; i++) {
      if (segment.payload[i] !== payloadPrefix[i]) return false;
    }
    return true;
  });
}

/** After SOI, and past a leading APP0/JFIF if there is one. */
export function insertionPoint(segments: readonly JpegSegment[]): number {
  let offset = 2; // past SOI
  for (const segment of segments) {
    if (segment.marker === MARKER_APP0 && segment.start === offset) {
      offset = segment.end;
      break;
    }
  }
  return offset;
}

export function buildApp1(payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  const out = new Uint8Array(payload.length + 4);
  out[0] = 0xff;
  out[1] = MARKER_APP1;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(payload, 4);
  return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
