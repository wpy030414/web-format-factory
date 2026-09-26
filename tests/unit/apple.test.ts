import { describe, expect, it } from 'vitest';

import {
  buildAppleMakerNote,
  readAppleMakerNoteIdentifier,
  relocateMovieMeta,
  writeAppleMakerNote,
} from '@/livephoto/apple.ts';

/**
 * The Apple-side metadata, checked against bytes produced by Apple's own frameworks rather
 * than against our own idea of what they should look like.
 *
 * Why that distinction is the whole point: a wrong offset in a maker note, or a metadata
 * box in the wrong place, is silent. Nothing throws, nothing warns — the pair simply
 * imports as two separate items instead of one Live Photo. So the reference is a real
 * artifact, and the acceptance that matters lives outside this file:
 * `docs/researches/live-photo-photos-import.md`.
 */

/** A maker note written by `CGImageDestination`, taken from its output byte for byte. */
const CORE_GRAPHICS_NOTE =
  '4170706c6520694f530000014d4d000100110002000000250000002000000000' +
  '37413744343139332d314439312d343930372d393846382d33423745343144393931443700';

const UUID = '7A7D4193-1D91-4907-98F8-3B7E41D991D7';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => new TextEncoder().encode(text);

/** Minimal JPEG: SOI, JFIF, then a scan. Enough for the segment walker. */
const JPEG = bytes(
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
  0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9,
);

function u32(value: number): Uint8Array {
  return bytes((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(8 + body);
  out.set(u32(out.length), 0);
  out.set(ascii(type), 4);
  let at = 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

interface Found {
  start: number;
  end: number;
}

/** Containers the parser should look inside; the tables live in `stbl`. */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta']);

function findBox(source: Uint8Array, from: number, to: number, type: string): Found | null {
  let at = from;
  while (at + 8 <= to) {
    const size =
      (source[at]! << 24) | (source[at + 1]! << 16) | (source[at + 2]! << 8) | source[at + 3]!;
    if (size < 8 || at + size > to) return null;
    const found = String.fromCharCode(source[at + 4]!, source[at + 5]!, source[at + 6]!, source[at + 7]!);
    if (found === type) return { start: at, end: at + size };
    if (CONTAINERS.has(found)) {
      const nested = findBox(source, at + 8, at + size, type);
      if (nested) return nested;
    }
    at += size;
  }
  return null;
}

describe('MakerNote：静图那一侧的配对标识', () => {
  it('与 Core Graphics 写出的字节完全一致', () => {
    // Not "looks right" — identical. An offset that is off by four still parses as a
    // maker note and still yields *a* UUID, which is exactly how this kind of bug survives
    // a hand-written test.
    expect(hex(buildAppleMakerNote(UUID))).toBe(CORE_GRAPHICS_NOTE);
  });

  it('写入后能从静图里读回来，且扫描段完好', () => {
    const tagged = writeAppleMakerNote(JPEG, UUID);
    expect(readAppleMakerNoteIdentifier(tagged)).toBe(UUID);
    expect(tagged.subarray(-4)).toEqual(JPEG.subarray(-4));
  });

  it('标识落在 Exif 子 IFD 里，而不是 IFD0 —— 后者是 Apple 不读的地方', () => {
    const tagged = writeAppleMakerNote(JPEG, UUID);
    const view = new DataView(tagged.buffer, tagged.byteOffset, tagged.byteLength);
    const tiffAt = Buffer.from(tagged).toString('latin1').indexOf('Exif\0\0') + 6;

    const ifd0 = tiffAt + view.getUint32(tiffAt + 4);
    expect(view.getUint16(ifd0)).toBe(1);
    expect(view.getUint16(ifd0 + 2)).toBe(0x8769); // ExifIFDPointer
    const subIfd = tiffAt + view.getUint32(ifd0 + 10);
    expect(view.getUint16(subIfd)).toBe(1);
    expect(view.getUint16(subIfd + 2)).toBe(0x927c); // MakerNote
  });

  it('静图已带 EXIF 时拒绝改写，而不是把别的元数据默默丢掉', () => {
    const withExif = writeAppleMakerNote(JPEG, UUID);
    expect(() => writeAppleMakerNote(withExif, 'OTHER-UUID')).toThrow(/already carries EXIF/);
  });

  it('不是 JPEG 就报错', () => {
    expect(() => writeAppleMakerNote(bytes(0, 1, 2, 3), UUID)).toThrow(/not a JPEG/);
  });
});

describe('relocateMovieMeta：视频那一侧的元数据位置', () => {
  /** ftyp + moov[mvhd, trak[…stbl[stco → mdat]], udta[meta]] + mdat. */
  function movie(): { mov: Uint8Array; mdatAt: number } {
    const ftyp = box('ftyp', ascii('qt  '), u32(0));
    const mvhd = box('mvhd', new Uint8Array(96));
    // ISO-shaped: version/flags before the handler, which is what ffmpeg writes.
    const udta = box('udta', box('meta', u32(0), box('hdlr', u32(0), ascii('mdta'))));
    const stco = box('stco', u32(0), u32(1), u32(0)); // patched once the layout is known
    const trak = box('trak', box('mdia', box('minf', box('stbl', stco))));
    const moov = box('moov', mvhd, trak, udta);
    const mdat = box('mdat', new Uint8Array(8));

    const mov = join([ftyp, moov, mdat]);
    const mdatAt = ftyp.length + moov.length;
    const stcoInFile = findBox(mov, 0, mov.length, 'stco')!;
    new DataView(mov.buffer).setUint32(stcoInFile.start + 16, mdatAt);
    return { mov, mdatAt };
  }

  it('把 udta/meta 提到 moov 下，并去掉那 4 字节 version/flags', () => {
    const { mov } = movie();
    const moved = relocateMovieMeta(mov);

    const moov = findBox(moved, 0, moved.length, 'moov')!;
    expect(findBox(moved, moov.start + 8, moov.end, 'udta')).toBeNull();
    const meta = findBox(moved, moov.start + 8, moov.end, 'meta')!;
    // QuickTime's `meta` box has no version/flags: the handler's *type* follows the
    // handler's own size field immediately after the header. Keeping those four bytes is
    // what makes Apple's reader miss the box entirely.
    expect(String.fromCharCode(
      moved[meta.start + 12]!, moved[meta.start + 13]!,
      moved[meta.start + 14]!, moved[meta.start + 15]!,
    )).toBe('hdlr');
  });

  it('movie 数据跟着移动，块偏移必须一起修正', () => {
    const { mov } = movie();
    const moved = relocateMovieMeta(mov);

    const mdat = findBox(moved, 0, moved.length, 'mdat')!;
    const stco = findBox(moved, 0, moved.length, 'stco')!;
    // A stale offset is a file that opens and whose samples are garbage — the failure this
    // assertion exists to prevent.
    expect(new DataView(moved.buffer).getUint32(stco.start + 16)).toBe(mdat.start);
  });

  it('没有 udta/meta 时原样返回', () => {
    const ftyp = box('ftyp', ascii('qt  '), u32(0));
    const moov = box('moov', box('mvhd', new Uint8Array(96)));
    const mov = join([ftyp, moov]);
    expect(relocateMovieMeta(mov)).toEqual(mov);
  });
});
