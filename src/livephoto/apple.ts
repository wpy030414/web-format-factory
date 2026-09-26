/**
 * Apple-side Live Photo metadata: the identifier inside the still's MakerNotes, and where
 * the movie has to keep its own copy of it.
 *
 * Both shapes here were reverse-engineered from real Apple output and then verified the
 * only way that counts — by importing the result into Photos on a real Mac and checking
 * that two files became one Live Photo. See
 * `docs/researches/live-photo-photos-import.md`. Treat every offset below as load-bearing:
 * get one wrong and nothing throws, the pair simply imports as two separate items.
 */

import {
  buildApp1,
  concat,
  findApp1,
  insertionPoint,
  readJpegSegments,
} from './jpeg.ts';

/* ------------------------------------------------- the still: Apple MakerNotes, key 17 */

/** The maker note's magic, version and byte order — Core Graphics writes exactly these. */
const MAKER_NOTE_MAGIC = 'Apple iOS\0';
const MAKER_NOTE_HEADER = 14; // magic (10) + version (2) + byte order (2)
const MAKER_NOTE_ENTRY = 12;
const MAKER_NOTE_TAG = 17; // kCGImagePropertyMakerAppleDictionary's content identifier

/** The EXIF APP1 payload prefix; the TIFF header follows it. */
const EXIF_PREFIX = new TextEncoder().encode('Exif\0\0');

/**
 * The Apple maker note carrying nothing but the pairing identifier.
 *
 * Layout, verified byte for byte against `CGImageDestination` output:
 *
 *   "Apple iOS\0"   10 bytes
 *   00 01            2 bytes  version
 *   "MM"             2 bytes  big-endian from here
 *   entry count      2 bytes
 *   one entry       12 bytes  tag 17, ASCII, the UUID with a NUL
 *   next IFD         4 bytes  always 0 here
 *   the UUID
 *
 * The value's offset is relative to the start of the maker note itself, not to the
 * enclosing TIFF header — which is the one thing a hand-written note most often gets
 * wrong, because the number happens to be the same until the note grows past one entry.
 */
export function buildAppleMakerNote(uuid: string): Uint8Array {
  const value = new TextEncoder().encode(`${uuid}\0`);
  const valueOffset = MAKER_NOTE_HEADER + 2 + MAKER_NOTE_ENTRY + 4;
  const out = new Uint8Array(valueOffset + value.length);
  const view = new DataView(out.buffer);

  out.set(new TextEncoder().encode(MAKER_NOTE_MAGIC), 0);
  out[10] = 0x00;
  out[11] = 0x01; // version
  out[12] = 0x4d;
  out[13] = 0x4d; // "MM"

  view.setUint16(MAKER_NOTE_HEADER + 0, 1); // one entry
  view.setUint16(MAKER_NOTE_HEADER + 2, MAKER_NOTE_TAG);
  view.setUint16(MAKER_NOTE_HEADER + 4, 2); // type 2 = ASCII
  view.setUint32(MAKER_NOTE_HEADER + 6, value.length);
  view.setUint32(MAKER_NOTE_HEADER + 10, valueOffset);
  view.setUint32(MAKER_NOTE_HEADER + 14, 0); // no next IFD

  out.set(value, valueOffset);
  return out;
}

/**
 * Wrap a maker note in the smallest EXIF that matches what Core Graphics itself produces:
 * IFD0 holds nothing but the Exif sub-IFD pointer, and the note lives in that sub-IFD.
 * Putting the note in IFD0 is the obvious guess and the wrong one — Apple's reader does
 * not look there.
 */
function buildExifApp1(note: Uint8Array): Uint8Array {
  const TIFF_HEADER = 8;
  const ifd0Size = 2 + 12 + 4; // one entry
  const subIfdOffset = TIFF_HEADER + ifd0Size;
  const noteOffset = subIfdOffset + 2 + 12 + 4; // one entry

  const tiff = new Uint8Array(noteOffset + note.length);
  const view = new DataView(tiff.buffer);

  tiff[0] = 0x4d;
  tiff[1] = 0x4d; // "MM"
  view.setUint16(2, 42);
  view.setUint32(4, TIFF_HEADER);

  view.setUint16(TIFF_HEADER, 1);
  let at = TIFF_HEADER + 2;
  view.setUint16(at, 0x8769); // ExifIFDPointer
  view.setUint16(at + 2, 4); // LONG
  view.setUint32(at + 4, 1);
  view.setUint32(at + 8, subIfdOffset);
  view.setUint32(at + 12, 0); // no IFD1

  view.setUint16(subIfdOffset, 1);
  at = subIfdOffset + 2;
  view.setUint16(at, 0x927c); // MakerNote
  view.setUint16(at + 2, 7); // UNDEFINED
  view.setUint32(at + 4, note.length);
  view.setUint32(at + 8, noteOffset);
  view.setUint32(at + 12, 0); // no next IFD

  tiff.set(note, noteOffset);
  return buildApp1(concat([EXIF_PREFIX, tiff]));
}

/**
 * The pairing identifier a still carries in its maker notes, or null.
 *
 * This is the field Apple actually writes and the one Photos actually reads — not the XMP
 * `apple:ContentIdentifier` the detector used to look for. See the research note.
 */
export function readAppleMakerNoteIdentifier(jpeg: Uint8Array): string | null {
  const exif = findApp1(readJpegSegments(jpeg), EXIF_PREFIX);
  if (!exif) return null;

  const tiff = exif.payload.subarray(EXIF_PREFIX.length);
  if (tiff.length < 8) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const little = view.getUint16(0) === 0x4949;
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);

  const ifd0 = u32(4);
  const subIfd = entryValue(tiff, view, ifd0, 0x8769, little);
  if (subIfd === null) return null;
  const note = entryValue(tiff, view, subIfd, 0x927c, little);
  if (note === null || note + 14 > tiff.length) return null;

  // The note carries its own byte order, independent of the enclosing TIFF header.
  const noteLittle = u16(note + 0) === 0x4949 || tiff[note] === 0x49;
  const readNote16 = (o: number) => view.getUint16(o, noteLittle);
  const readNote32 = (o: number) => view.getUint32(o, noteLittle);
  if (readNote16(note + 14) < 1) return null;

  const entry = note + 16;
  if (readNote16(entry) !== MAKER_NOTE_TAG) return null;
  const count = readNote32(entry + 4);
  const valueAt = note + readNote32(entry + 8);
  if (valueAt + count > tiff.length) return null;

  return new TextDecoder('utf-8', { fatal: false })
    .decode(tiff.subarray(valueAt, valueAt + count))
    .replace(/\0.*$/s, '');
}

/** The value field of the first entry with `tag`, clamped to the TIFF block. */
function entryValue(
  tiff: Uint8Array,
  view: DataView,
  ifd: number,
  tag: number,
  little: boolean,
): number | null {
  if (ifd + 2 > tiff.length) return null;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    if (view.getUint16(entry, little) !== tag) continue;
    const value = view.getUint32(entry + 8, little);
    return value < tiff.length ? value : null;
  }
  return null;
}

/**
 * Put the pairing identifier into a JPEG's maker notes.
 *
 * Refuses when the JPEG already carries EXIF rather than replacing it: an existing EXIF
 * segment holds the source's own metadata, and splicing a note into it without a full EXIF
 * editor would quietly drop the rest. Callers are expected to have reused that still's own
 * identifier instead — which is what `readAppleMakerNoteIdentifier` is for.
 */
export function writeAppleMakerNote(jpeg: Uint8Array, uuid: string): Uint8Array {
  const segments = readJpegSegments(jpeg);
  if (segments.length === 0) {
    throw new Error('not a JPEG: cannot embed the Apple maker note');
  }
  if (findApp1(segments, EXIF_PREFIX)) {
    throw new Error('this still already carries EXIF; not overwriting it');
  }

  const app1 = buildExifApp1(buildAppleMakerNote(uuid));
  const at = insertionPoint(segments);
  return concat([jpeg.subarray(0, at), app1, jpeg.subarray(at)]);
}

/* ---------------------------------------- the movie: the metadata has to sit in `moov` */

interface Box {
  type: string;
  /** Offset of the box's size field. */
  start: number;
  /** Offset just past the box. */
  end: number;
}

function boxes(bytes: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    const size = (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (size < 8 || at + size > to) break; // desynchronised; stop rather than guess
    out.push({
      type: String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!),
      start: at,
      end: at + size,
    });
    at += size;
  }
  return out;
}

function makeBox(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  const size = out.length;
  out[0] = (size >>> 24) & 0xff;
  out[1] = (size >>> 16) & 0xff;
  out[2] = (size >>> 8) & 0xff;
  out[3] = size & 0xff;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

/**
 * Move the movie's QuickTime metadata to where Apple keeps it.
 *
 * ffmpeg writes it as an ISO-style `moov/udta/meta`: four bytes of version/flags that
 * QuickTime's own `meta` box does not have. Apple's reader goes to `moov/meta`, finds
 * nothing, and the movie ends up looking as if it carried no content identifier at all —
 * so the pair never becomes a Live Photo, and nothing anywhere says why.
 *
 * Both halves of that matter, and this was measured rather than reasoned: a note that is
 * QuickTime-shaped but still nested in `udta` is not found, and one that sits directly
 * under `moov` but keeps its four extra bytes is not found either.
 */
export function relocateMovieMeta(mov: Uint8Array): Uint8Array {
  const top = boxes(mov, 0, mov.length);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return mov;
  const mdat = top.find((b) => b.type === 'mdat');

  const children = boxes(mov, moov.start + 8, moov.end);
  const udta = children.find((b) => b.type === 'udta');
  if (!udta) return mov;
  const udtaChildren = boxes(mov, udta.start + 8, udta.end);
  const meta = udtaChildren.find((b) => b.type === 'meta');
  if (!meta) return mov;

  const body = mov.subarray(meta.start + 8, meta.end);
  // A `meta` box that already starts with `hdlr` is QuickTime-shaped and needs no surgery;
  // one that starts with four zero bytes is ISO-shaped and must lose them.
  const isIso = body.length >= 8 && body[0] === 0 && body[1] === 0 && body[2] === 0 && body[3] === 0;
  const quickTimeMeta = makeBox('meta', isIso ? body.subarray(4) : body);

  const keptChildren = children.filter((b) => b !== udta).map((b) => mov.subarray(b.start, b.end));
  const keptUdtaChildren = udtaChildren.filter((b) => b !== meta).map((b) => mov.subarray(b.start, b.end));
  const moovBody = concat([
    ...keptChildren,
    ...(keptUdtaChildren.length ? [makeBox('udta', concat(keptUdtaChildren))] : []),
    quickTimeMeta,
  ]);

  const newMoov = makeBox('moov', moovBody);
  const out = concat([mov.subarray(0, moov.start), newMoov, mov.subarray(moov.end)]);

  // Chunk offsets point into `mdat`. If the movie's data moved, every one of them moves
  // with it — a stale offset is a file that opens and whose samples are garbage.
  const delta = newMoov.length - (moov.end - moov.start);
  if (delta !== 0 && mdat && mdat.start > moov.start) {
    shiftChunkOffsets(out, moov.start + 8, moov.start + newMoov.length, delta);
  }
  return out;
}

/** Add `delta` to every `stco`/`co64` entry inside the given box range, in place. */
function shiftChunkOffsets(bytes: Uint8Array, from: number, to: number, delta: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const box of boxes(bytes, from, to)) {
    if (box.type === 'stco' || box.type === 'co64') {
      const width = box.type === 'stco' ? 4 : 8;
      const count = view.getUint32(box.start + 12);
      for (let i = 0; i < count; i++) {
        const at = box.start + 16 + i * width;
        if (at + width > box.end) break;
        const value = width === 4 ? view.getUint32(at) : Number(view.getBigUint64(at));
        const shifted = value + delta;
        if (width === 4) view.setUint32(at, shifted);
        else view.setBigUint64(at, BigInt(shifted));
      }
      continue;
    }
    // Descend into containers. `stbl` is where the tables actually live.
    if (box.type === 'trak' || box.type === 'mdia' || box.type === 'minf' || box.type === 'stbl') {
      shiftChunkOffsets(bytes, box.start + 8, box.end, delta);
    }
  }
}
